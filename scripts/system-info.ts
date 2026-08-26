#!/usr/bin/env node
/**
 * Level 0 — Environment and hardware detection.
 *
 * Reports the facts that decide which local model is realistic on this machine:
 * OS, CPU (physical cores matter more than logical), RAM, GPU, GPU VRAM,
 * available disk space, and whether the expected toolchain is present.
 *
 * Deliberately dependency-free. It runs before `npm install` has ever been
 * executed, so it may only use the Node standard library.
 *
 * Run:
 *   node --experimental-strip-types scripts/system-info.ts
 *   node --experimental-strip-types scripts/system-info.ts --json
 *
 * (Node >= 22.6 strips the type annotations natively; no build step, no ts-node.)
 *
 * Detection is best-effort. Anything that cannot be read is reported as
 * "not detected" and a manual command is printed instead — a wrong number here
 * would propagate into the model choice, so an honest gap beats a guess.
 */

import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

interface GpuInfo {
  name: string;
  vramBytes: number | null;
  vramSource: string;
  driver: string | null;
}

interface DiskInfo {
  label: string;
  totalBytes: number;
  freeBytes: number;
}

interface ToolInfo {
  name: string;
  installed: boolean;
  version: string | null;
}

interface SystemReport {
  detectedAt: string;
  platform: string;
  osName: string;
  osVersion: string;
  arch: string;
  machine: string | null;
  cpuModel: string;
  cpuPhysicalCores: number | null;
  cpuLogicalCores: number;
  cpuSpeedMhz: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  memoryModules: string[];
  gpus: GpuInfo[];
  disks: DiskInfo[];
  virtualization: string | null;
  tools: ToolInfo[];
  warnings: string[];
}

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/** Run a command, returning trimmed stdout, or null if it fails or is missing. */
function run(cmd: string, timeoutMs = 15_000): string | null {
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      windowsHide: true,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Run a PowerShell snippet. The snippet must not contain double quotes —
 * it is passed through cmd.exe inside a double-quoted argument. Use single
 * quotes inside the snippet.
 */
function ps(snippet: string): string | null {
  if (!IS_WINDOWS) return null;
  return run(`powershell -NoProfile -NonInteractive -Command "${snippet}"`);
}

function gib(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) return 'not detected';
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function pad(label: string, width = 22): string {
  return label.padEnd(width, ' ');
}

// ---------------------------------------------------------------- OS

function detectOsName(): string {
  if (IS_WINDOWS) {
    return ps('(Get-CimInstance Win32_OperatingSystem).Caption') ?? `Windows ${os.release()}`;
  }
  if (IS_MAC) {
    const name = run('sw_vers -productName');
    const ver = run('sw_vers -productVersion');
    return name && ver ? `${name} ${ver}` : `macOS ${os.release()}`;
  }
  const pretty = run("grep -oP '(?<=^PRETTY_NAME=).*' /etc/os-release | tr -d '\"'");
  return pretty ?? `${os.type()} ${os.release()}`;
}

function detectMachine(): string | null {
  if (IS_WINDOWS) {
    return ps('$c = Get-CimInstance Win32_ComputerSystem; $c.Manufacturer + \' \' + $c.Model');
  }
  if (IS_MAC) return run('sysctl -n hw.model');
  return run('cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null');
}

// ---------------------------------------------------------------- CPU

function detectPhysicalCores(): number | null {
  if (IS_WINDOWS) {
    const raw = ps('(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum');
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  if (IS_MAC) {
    const raw = run('sysctl -n hw.physicalcpu');
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  const raw = run("lscpu -p=Core,Socket | grep -v '^#' | sort -u | wc -l");
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------- Memory

function detectMemoryModules(): string[] {
  if (IS_WINDOWS) {
    const raw = ps(
      'Get-CimInstance Win32_PhysicalMemory | ForEach-Object { [string][math]::Round($_.Capacity/1GB,0) + \' GB @ \' + [string]$_.Speed + \' MT/s\' }'
    );
    return raw ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  }
  if (IS_LINUX) {
    const raw = run("sudo -n dmidecode -t memory 2>/dev/null | grep -E '^\\s+Size: [0-9]'");
    return raw ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  }
  return [];
}

// ---------------------------------------------------------------- GPU

function detectGpus(): GpuInfo[] {
  const gpus: GpuInfo[] = [];

  // NVIDIA first — nvidia-smi is authoritative when present, on every platform.
  const smi = run('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits');
  if (smi) {
    for (const line of smi.split(/\r?\n/)) {
      const [name, mib] = line.split(',').map((s) => s.trim());
      if (!name) continue;
      const mibNum = Number.parseInt(mib ?? '', 10);
      gpus.push({
        name,
        vramBytes: Number.isFinite(mibNum) ? mibNum * 1024 * 1024 : null,
        vramSource: 'nvidia-smi',
        driver: null,
      });
    }
    if (gpus.length > 0) return gpus;
  }

  if (IS_WINDOWS) {
    // Win32_VideoController.AdapterRAM is a uint32 and silently wraps above 4 GB,
    // so it is only used as a name/driver source, never as the VRAM figure.
    const raw = ps(
      'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + \'|\' + $_.DriverVersion }'
    );
    // Dedicated VRAM lives in the display-adapter class key as a 64-bit value.
    const regRaw = ps(
      "Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.'HardwareInformation.qwMemorySize') { $p.DriverDesc + '|' + [string]$p.'HardwareInformation.qwMemorySize' } }"
    );
    const vramByName = new Map<string, number>();
    if (regRaw) {
      for (const line of regRaw.split(/\r?\n/)) {
        const [desc, bytes] = line.split('|').map((s) => s.trim());
        const n = Number.parseInt(bytes ?? '', 10);
        if (desc && Number.isFinite(n)) vramByName.set(desc, n);
      }
    }
    if (raw) {
      for (const line of raw.split(/\r?\n/)) {
        const [name, driver] = line.split('|').map((s) => s.trim());
        if (!name) continue;
        const vram = vramByName.get(name) ?? null;
        gpus.push({
          name,
          vramBytes: vram,
          vramSource: vram === null ? 'none dedicated (integrated / shared system RAM)' : 'registry qwMemorySize',
          driver: driver || null,
        });
      }
    }
    return gpus;
  }

  if (IS_MAC) {
    const raw = run('system_profiler SPDisplaysDataType 2>/dev/null');
    if (raw) {
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s{4}(.+):$/);
        if (m && m[1] && !m[1].includes('Displays')) {
          gpus.push({
            name: m[1].trim(),
            vramBytes: null,
            vramSource: 'unified memory (Apple Silicon shares system RAM)',
            driver: null,
          });
        }
      }
    }
    return gpus;
  }

  const lspci = run("lspci 2>/dev/null | grep -Ei 'vga|3d|display'");
  if (lspci) {
    for (const line of lspci.split(/\r?\n/)) {
      const name = line.split(': ').slice(1).join(': ').trim();
      if (name) {
        gpus.push({ name, vramBytes: null, vramSource: 'not detected via lspci', driver: null });
      }
    }
  }
  return gpus;
}

// ---------------------------------------------------------------- Disk

function detectDisks(): DiskInfo[] {
  const disks: DiskInfo[] = [];

  if (IS_WINDOWS) {
    const raw = ps(
      'Get-CimInstance Win32_LogicalDisk -Filter (\'DriveType=3\') | ForEach-Object { $_.DeviceID + \'|\' + [string]$_.Size + \'|\' + [string]$_.FreeSpace }'
    );
    if (raw) {
      for (const line of raw.split(/\r?\n/)) {
        const [id, total, free] = line.split('|').map((s) => s.trim());
        const t = Number.parseInt(total ?? '', 10);
        const f = Number.parseInt(free ?? '', 10);
        if (id && Number.isFinite(t) && Number.isFinite(f)) {
          disks.push({ label: id, totalBytes: t, freeBytes: f });
        }
      }
    }
    if (disks.length > 0) return disks;
  }

  // Cross-platform fallback: statfs on the current working directory.
  try {
    const st = fs.statfsSync(process.cwd());
    disks.push({
      label: `${process.cwd()} (filesystem)`,
      totalBytes: st.blocks * st.bsize,
      freeBytes: st.bavail * st.bsize,
    });
  } catch {
    /* reported as an empty disk list */
  }
  return disks;
}

// ---------------------------------------------------------------- Virtualization

function detectVirtualization(): string | null {
  if (IS_WINDOWS) {
    const hv = ps('[string](Get-CimInstance Win32_ComputerSystem).HypervisorPresent');
    if (hv === null) return null;
    const present = hv.toLowerCase() === 'true';
    return present
      ? 'available (hypervisor present and active)'
      : 'hypervisor not present — check that virtualization is enabled in BIOS/UEFI';
  }
  if (IS_LINUX) {
    const flags = run("grep -Ec '(vmx|svm)' /proc/cpuinfo");
    if (flags === null) return null;
    return Number.parseInt(flags, 10) > 0 ? 'available (vmx/svm CPU flags present)' : 'not available';
  }
  if (IS_MAC) return 'available (Hypervisor.framework)';
  return null;
}

// ---------------------------------------------------------------- Toolchain

/**
 * Pull the version out of `--version` output. Some CLIs (ollama) print
 * warnings on the first line and the version on a later one, so take the
 * first line that actually contains a version number rather than line 0.
 */
function extractVersion(raw: string): string {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const versioned = lines.find((l) => /\d+\.\d+/.test(l));
  return versioned ?? lines[0] ?? raw.trim();
}

function detectTools(): ToolInfo[] {
  const wanted = ['node', 'npm', 'pnpm', 'git', 'docker', 'ollama'];
  return wanted.map((name) => {
    const version = run(`${name} --version`, 10_000);
    return {
      name,
      installed: version !== null,
      version: version ? extractVersion(version) : null,
    };
  });
}

// ---------------------------------------------------------------- Manual fallbacks

function manualCommands(): string[] {
  if (IS_WINDOWS) {
    return [
      'GPU + driver:   Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion',
      'Dedicated VRAM: (Get-ItemProperty \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000\').\'HardwareInformation.qwMemorySize\'',
      'NVIDIA VRAM:    nvidia-smi --query-gpu=name,memory.total --format=csv',
      'Full GPU report: dxdiag  (click "Save All Information", read the Display section)',
      'Shared GPU memory: open Task Manager > Performance > GPU',
      'CPU cores:      Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors',
      'Disk free:      Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, Size, FreeSpace',
    ];
  }
  if (IS_MAC) {
    return [
      'GPU / VRAM:     system_profiler SPDisplaysDataType',
      'CPU cores:      sysctl -n hw.physicalcpu hw.logicalcpu',
      'Memory:         sysctl -n hw.memsize',
      'Disk free:      df -h /',
    ];
  }
  return [
    'GPU:            lspci | grep -Ei "vga|3d|display"',
    'NVIDIA VRAM:    nvidia-smi --query-gpu=name,memory.total --format=csv',
    'AMD VRAM:       rocm-smi --showmeminfo vram',
    'Intel GPU:      lspci -v -s $(lspci | grep VGA | cut -d" " -f1)',
    'CPU cores:      lscpu | grep -E "^CPU\\(s\\)|Core\\(s\\) per socket|Socket"',
    'Memory:         free -h',
    'Disk free:      df -h .',
  ];
}

// ---------------------------------------------------------------- Report

function buildReport(): SystemReport {
  const cpus = os.cpus();
  const warnings: string[] = [];

  const gpus = detectGpus();
  if (gpus.length === 0) {
    warnings.push('No GPU detected automatically. Run the manual commands below and report the result.');
  } else if (gpus.every((g) => g.vramBytes === null)) {
    warnings.push(
      'No dedicated VRAM found. The GPU is integrated and shares system RAM, so plan for CPU inference.'
    );
  }

  const physical = detectPhysicalCores();
  if (physical !== null && physical <= 2) {
    warnings.push(
      `Only ${physical} physical CPU core(s). Local LLM throughput scales with physical cores — expect slow generation and much slower prompt processing.`
    );
  }

  const disks = detectDisks();
  const smallest = disks.length > 0 ? Math.min(...disks.map((d) => d.freeBytes)) : null;
  if (smallest !== null && smallest < 20 * 1024 ** 3) {
    warnings.push('Less than 20 GB free on a drive. Model files are 1-5 GB each; check disk before pulling.');
  }

  return {
    detectedAt: new Date().toISOString(),
    platform: process.platform,
    osName: detectOsName(),
    osVersion: os.release(),
    arch: process.arch,
    machine: detectMachine(),
    cpuModel: cpus[0]?.model.trim() ?? 'not detected',
    cpuPhysicalCores: physical,
    cpuLogicalCores: cpus.length,
    cpuSpeedMhz: cpus[0]?.speed ?? 0,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    memoryModules: detectMemoryModules(),
    gpus,
    disks,
    virtualization: detectVirtualization(),
    tools: detectTools(),
    warnings,
  };
}

function printReport(r: SystemReport): void {
  const line = '='.repeat(64);
  console.log(line);
  console.log('  LEVEL 0 — SYSTEM REPORT');
  console.log(`  ${r.detectedAt}`);
  console.log(line);

  console.log('\n-- Operating system ---------------------------------------------');
  console.log(pad('  Name') + r.osName);
  console.log(pad('  Kernel/release') + r.osVersion);
  console.log(pad('  Architecture') + r.arch);
  if (r.machine) console.log(pad('  Machine') + r.machine);

  console.log('\n-- CPU ----------------------------------------------------------');
  console.log(pad('  Model') + r.cpuModel);
  console.log(pad('  Physical cores') + (r.cpuPhysicalCores ?? 'not detected'));
  console.log(pad('  Logical cores') + r.cpuLogicalCores);
  console.log(pad('  Reported speed') + `${r.cpuSpeedMhz} MHz`);

  console.log('\n-- Memory -------------------------------------------------------');
  console.log(pad('  Total RAM') + gib(r.totalMemoryBytes));
  console.log(pad('  Available RAM') + gib(r.freeMemoryBytes));
  for (const m of r.memoryModules) console.log(pad('  Module') + m);

  console.log('\n-- GPU ----------------------------------------------------------');
  if (r.gpus.length === 0) {
    console.log('  none detected automatically');
  } else {
    for (const g of r.gpus) {
      console.log(pad('  Adapter') + g.name);
      console.log(pad('  VRAM') + `${gib(g.vramBytes)}  [${g.vramSource}]`);
      if (g.driver) console.log(pad('  Driver') + g.driver);
    }
  }

  console.log('\n-- Disk ---------------------------------------------------------');
  if (r.disks.length === 0) {
    console.log('  not detected');
  } else {
    for (const d of r.disks) {
      const pct = d.totalBytes > 0 ? ((d.freeBytes / d.totalBytes) * 100).toFixed(1) : '?';
      console.log(pad(`  ${d.label}`) + `${gib(d.freeBytes)} free of ${gib(d.totalBytes)}  (${pct}%)`);
    }
  }

  console.log('\n-- Virtualization -----------------------------------------------');
  console.log(pad('  Status') + (r.virtualization ?? 'not detected'));

  console.log('\n-- Toolchain ----------------------------------------------------');
  for (const t of r.tools) {
    console.log(pad(`  ${t.name}`) + (t.installed ? t.version : 'NOT INSTALLED'));
  }

  if (r.warnings.length > 0) {
    console.log('\n-- Warnings -----------------------------------------------------');
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }

  console.log('\n-- Manual commands (if detection above is incomplete) ------------');
  for (const c of manualCommands()) console.log(`  ${c}`);

  console.log(`\n${line}`);
  console.log('  This script only reads. It installs nothing and downloads nothing.');
  console.log(line);
}

const report = buildReport();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}
