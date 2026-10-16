/**
 * Windows security and machine primitives, called directly rather than through PowerShell.
 *
 * Every question this module answers -- who owns a path, what its ACL says, what machine this is --
 * used to cost a `powershell.exe` process. Measured on a native Windows host: 271ms for one
 * owner-only ACL round trip and 332ms for the machine probe, against 0.143ms and 0.003ms for the
 * same answers through these entry points. That is not a tuning difference. One `cosyncing setup`
 * run performs about 4,470 owner-only operations, which is twenty minutes of process spawning at
 * best and sixty-six on a CI runner, against under a second here.
 *
 * The cost was never the only problem. Routing security decisions through a shell meant they
 * inherited a shell's environment, and Windows PowerShell 5.1 handed an inherited `PSModulePath`
 * cannot auto-load `Microsoft.PowerShell.Security` -- so `Get-Acl` stopped resolving on any host
 * with PowerShell 7 installed, and the ownership proof silently answered "unknown" instead. The
 * machine probe compiled C# at runtime through `Add-Type` and blocked past twenty seconds on a host
 * with a cold module-analysis cache, which refused a supported machine at startup. Neither failure
 * is reachable from here: there is no shell, no module path, and no compiler.
 *
 * Nothing in this file degrades quietly. A caller that cannot load the library gets `undefined` and
 * decides for itself whether that is fatal -- the machine probe answers 'unknown', owner-only
 * enforcement refuses -- because "the machine would not say" and "the answer is no" are different
 * facts and only the caller knows which one it can survive.
 */

/** Win32 `SE_OBJECT_TYPE`: the only object type this module addresses. */
const SE_FILE_OBJECT = 1;

/** `SECURITY_INFORMATION` bits. */
const OWNER_SECURITY_INFORMATION = 0x0000_0001;
const DACL_SECURITY_INFORMATION = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;

/** `SECURITY_DESCRIPTOR_CONTROL`: the DACL is protected from inheritance. */
const SE_DACL_PROTECTED = 0x1000;

/** `TOKEN_QUERY`. */
const TOKEN_QUERY = 0x0008;
/** `TOKEN_INFORMATION_CLASS`. */
const TOKEN_USER_CLASS = 1;
const TOKEN_OWNER_CLASS = 4;

/** `SDDL_REVISION_1`. */
const SDDL_REVISION_1 = 1;

/** `ERROR_ALREADY_EXISTS`: somebody else created this directory first. */
const ERROR_ALREADY_EXISTS = 183;

/** ACE header flags, as Windows stores them. */
const OBJECT_INHERIT_ACE = 0x01;
const CONTAINER_INHERIT_ACE = 0x02;
const NO_PROPAGATE_INHERIT_ACE = 0x04;
const INHERIT_ONLY_ACE = 0x08;
const INHERITED_ACE = 0x10;

/** ACE types. Only these two carry meaning for an owner-only policy. */
const ACCESS_ALLOWED_ACE_TYPE = 0x00;
const ACCESS_DENIED_ACE_TYPE = 0x01;

/** `PROCESS_QUERY_LIMITED_INFORMATION`: enough to read a process's command line, nothing more. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** `PROCESSINFOCLASS` `ProcessCommandLineInformation` (Windows 8.1 and later). */
const PROCESS_COMMAND_LINE_INFORMATION = 60;
/** `ERROR_INVALID_PARAMETER`: `OpenProcess` names no running process. */
const ERROR_INVALID_PARAMETER = 87;
/** `STATUS_PROCESS_IS_TERMINATING`: the process has exited; a handle still names it. */
const STATUS_PROCESS_IS_TERMINATING = 0xc000010a | 0;
/** NTSTATUS values that mean "the buffer was too small; here is the size". */
const STATUS_RESIZE = new Set([0xc0000004 | 0, 0xc0000023 | 0, 0x80000005 | 0]);
/** A command line is at most 32,767 UTF-16 units, after the 16-byte `UNICODE_STRING` header. */
const COMMAND_LINE_MAX_BYTES = 16 + 32_768 * 2;

/** `IMAGE_FILE_MACHINE_*` values `IsWow64Process2` reports. */
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const IMAGE_FILE_MACHINE_UNKNOWN = 0x0000;

/** `TH32CS_SNAPPROCESS`: a Toolhelp snapshot of the process list and nothing else. */
const TH32CS_SNAPPROCESS = 0x0000_0002;
/** `ERROR_NO_MORE_FILES`: `Process32NextW` reached the end of the list, which is the only clean end. */
const ERROR_NO_MORE_FILES = 18;
/**
 * `PROCESSENTRY32W` in a 64-bit process: `dwSize`, `cntUsage`, `th32ProcessID` at 8, the pointer-sized
 * `th32DefaultHeapID` at 16, `th32ModuleID`, `cntThreads`, `th32ParentProcessID` at 32,
 * `pcPriClassBase`, `dwFlags`, then `szExeFile[MAX_PATH]` at 44, padded to 568.
 */
const PROCESSENTRY32W_SIZE = 568;
const PROCESSENTRY32W_PID = 8;
const PROCESSENTRY32W_PARENT_PID = 32;
const PROCESSENTRY32W_EXE_FILE = 44;
const MAX_PATH = 260;
/** More processes than this is not a list this walk will finish; it refuses rather than truncates. */
const PROCESS_TABLE_MAX = 65_536;
/** A `FILETIME` (100 ns ticks since 1601-01-01 UTC) at the Unix epoch. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const FILETIME_TICKS_PER_SECOND = 10_000_000n;

/**
 * A `FILETIME` as UTC in the round-trip form .NET's `ToString('o')` writes
 * (`2026-10-15T10:00:00.1234567Z`), or '' for a time before 1970, which no running process has.
 *
 * The same shape the PowerShell snapshot reports for a process start, so every start in a snapshot
 * orders by plain string comparison, which is how ancestry compares them. WMI truncates
 * `CreationDate` to the microsecond; this keeps the kernel's full 100 ns, which agrees with it to the
 * microsecond and orders two processes created within one microsecond correctly.
 */
export function windowsFileTimeIso(ticks: bigint): string {
  const sinceEpoch = ticks - FILETIME_UNIX_EPOCH;
  if (sinceEpoch < 0n) return '';
  const seconds = sinceEpoch / FILETIME_TICKS_PER_SECOND;
  const fraction = sinceEpoch % FILETIME_TICKS_PER_SECOND;
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${whole}.${fraction.toString().padStart(7, '0')}Z`;
}

/**
 * The start a process-table row may claim: its creation time, unless that is unknown (0) or LATER than
 * the moment the list was taken. A pid is free for reuse the instant its process is gone, and the
 * creation time is read after the list, so a process created after the list cannot be the one the
 * list named under that pid. Claiming its start would splice two processes into one identity. One
 * created before the list was taken was alive the whole time, so it holds the pid the list saw.
 */
export function windowsProcessStart(created: bigint, listedAt: bigint): string {
  if (created <= 0n || created > listedAt) return '';
  return windowsFileTimeIso(created);
}

/** One `PROCESSENTRY32W`: pid, parent pid, and the image name (`szExeFile`, read up to its NUL). */
export function readProcessEntry32W(entry: Uint8Array): { pid: number; parentPid: number; name: string } {
  if (entry.byteLength < PROCESSENTRY32W_SIZE) throw new Error('a PROCESSENTRY32W is 568 bytes');
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  let end = PROCESSENTRY32W_EXE_FILE;
  const limit = PROCESSENTRY32W_EXE_FILE + MAX_PATH * 2;
  while (end < limit && view.getUint16(end, true) !== 0) end += 2;
  return {
    pid: view.getUint32(PROCESSENTRY32W_PID, true),
    parentPid: view.getUint32(PROCESSENTRY32W_PARENT_PID, true),
    name: Buffer.from(entry.buffer, entry.byteOffset + PROCESSENTRY32W_EXE_FILE, end - PROCESSENTRY32W_EXE_FILE)
      .toString('utf16le'),
  };
}

/** One row of the host process table. */
export interface WindowsProcessTableEntry {
  pid: number;
  /** 0 when Windows reported none. */
  parentPid: number;
  /** The image name, as Windows lists it (`codex.exe`). */
  name: string;
  /** `windowsFileTimeIso` of its creation time; '' when the process would not say (see `processTable`). */
  start: string;
}

export interface WindowsAceSnapshot {
  sid: string;
  type: 'Allow' | 'Deny' | 'Other';
  rights: number;
  inherited: boolean;
  /**
   * .NET `InheritanceFlags`, not the raw ACE flags.
   *
   * The two enumerations disagree: Windows numbers OBJECT_INHERIT_ACE 1 and CONTAINER_INHERIT_ACE 2,
   * while .NET numbers ContainerInherit 1 and ObjectInherit 2 -- the same two bits, swapped. They
   * coincide at 0 and at 3, which are the only values an owner-only policy produces, so a reader
   * comparing against those would never notice the difference. Translated anyway, because the values
   * this module reports are compared against numbers chosen when a PowerShell `Get-Acl` produced
   * them, and a snapshot that means something different from the one it replaces is the kind of
   * change that passes every test and is wrong.
   */
  inheritanceFlags: number;
  /** .NET `PropagationFlags`, translated for the same reason. */
  propagationFlags: number;
}

export interface WindowsSecuritySnapshot {
  ownerSid: string;
  protected: boolean;
  aces: WindowsAceSnapshot[];
}

export interface WindowsFfi {
  currentUserSid(): string;
  /**
   * The SID Windows stamps as the owner of objects THIS token creates.
   *
   * Equal to the user on an ordinary session and `BUILTIN\Administrators` on an elevated one, which
   * is why an object the process just created can come back owned by Administrators rather than by
   * the person who ran the command.
   */
  currentTokenOwnerSid(): string;
  nativeMachine(): 'x64' | 'arm64' | 'other' | 'unknown';
  readSecurity(path: string): WindowsSecuritySnapshot;
  applySecurity(path: string, sddl: string): void;
  createDirectory(path: string, sddl: string): void;
  pathOwnerSid(path: string): string;
  /**
   * The command line of a running process, read-only (`PROCESS_QUERY_LIMITED_INFORMATION`), or
   * `null` when no process has that pid or it has exited. Throws when the process exists but will not
   * say.
   */
  processCommandLine(pid: number): string | null;
  /**
   * Every process on the host (pid 0, the idle process, excepted), read-only and without a process
   * spawned: a Toolhelp snapshot for pid, parent pid and image name, then `GetProcessTimes` for each
   * start. A start is '' where the process will not open for `PROCESS_QUERY_LIMITED_INFORMATION`
   * (another user's, or a protected service's) and where its pid was reused after the list was taken.
   * Throws when the list cannot be read to its end.
   */
  processTable(): WindowsProcessTableEntry[];
}

type Pointer = number;

let loaded: WindowsFfi | undefined | null = null;

/**
 * The Windows primitives, or `undefined` where they cannot be reached.
 *
 * Resolved once and cached, including the failure: a host without `bun:ffi` will not grow one, and
 * retrying a failed `dlopen` per call would reintroduce exactly the per-operation cost this exists
 * to remove.
 */
export function windowsFfi(): WindowsFfi | undefined {
  if (loaded !== null) return loaded ?? undefined;
  loaded = undefined;
  if (process.platform !== 'win32') return undefined;
  try {
    loaded = load();
  } catch {
    // A caller that needs a definite answer refuses; one that can say 'unknown' says it.
    loaded = undefined;
  }
  return loaded ?? undefined;
}

function load(): WindowsFfi {
  // Required lazily and by name: importing `bun:ffi` at module scope would fail on every non-Bun
  // consumer of this package and on every platform that never calls any of this.
  // eslint-disable-next-line
  const ffi = require('bun:ffi') as typeof import('bun:ffi');
  const { dlopen, FFIType, ptr, toArrayBuffer } = ffi;

  const kernel32 = dlopen('kernel32.dll', {
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    IsWow64Process2: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    CreateDirectoryW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetLastError: { args: [], returns: FFIType.u32 },
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
  });
  // Resolved on first use, so a missing export can never take the security primitives down with it.
  let ntQueryInformationProcess: ((...args: never[]) => number) | undefined;
  const ntQuery = () => (ntQueryInformationProcess ??= dlopen('ntdll.dll', {
    NtQueryInformationProcess: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  }).symbols.NtQueryInformationProcess as (...args: never[]) => number);
  // The process-table entry points, resolved on first use like the one above. A Toolhelp handle is
  // INVALID_HANDLE_VALUE (-1) on failure, which a pointer return cannot carry intact, so it travels
  // as an i64 -- and its own CloseHandle binding takes it that way.
  const openProcessList = () => dlopen('kernel32.dll', {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i64 },
    Process32FirstW: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.bool },
    Process32NextW: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.bool },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetSystemTimeAsFileTime: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols;
  let processList: ReturnType<typeof openProcessList> | undefined;
  const advapi32 = dlopen('advapi32.dll', {
    OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
    GetTokenInformation: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
    ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetSecurityDescriptorDacl: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetSecurityDescriptorOwner: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetSecurityDescriptorControl: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetNamedSecurityInfoW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32 },
    SetNamedSecurityInfoW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32 },
    GetAce: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
  });

  const wide = (value: string): Uint8Array => {
    // A path carrying an interior NUL would be truncated by every W function that reads it, so it is
    // rejected here rather than silently addressing a different object.
    if (value.includes('\0')) throw new Error('Windows path contains a NUL');
    return new Uint8Array(Buffer.from(`${value}\0`, 'utf16le'));
  };

  const readPointer = (holder: BigUint64Array): Pointer => Number(holder[0]!);

  /** Read a NUL-terminated UTF-16 string that Windows allocated for us. */
  const readWide = (pointer: Pointer): string => {
    if (!pointer) return '';
    const units: number[] = [];
    for (let offset = 0; offset < 64 * 1024; offset += 2) {
      const unit = new Uint16Array(toArrayBuffer(pointer as never, offset, 2))[0]!;
      if (unit === 0) break;
      units.push(unit);
    }
    return String.fromCharCode(...units);
  };

  const sidToString = (sid: Pointer): string => {
    const out = new BigUint64Array(1);
    if (!advapi32.symbols.ConvertSidToStringSidW(sid as never, ptr(out) as never)) {
      throw new Error('ConvertSidToStringSidW failed');
    }
    const pointer = readPointer(out);
    try {
      return readWide(pointer);
    } finally {
      kernel32.symbols.LocalFree(pointer as never);
    }
  };

  /** The SID from one of this process token's information classes, as a string. */
  const tokenSid = (informationClass: number): string => {
    const tokenOut = new BigUint64Array(1);
    if (!advapi32.symbols.OpenProcessToken(
      kernel32.symbols.GetCurrentProcess(), TOKEN_QUERY, ptr(tokenOut) as never,
    )) {
      throw new Error('OpenProcessToken failed');
    }
    const token = readPointer(tokenOut);
    try {
      const size = new Uint32Array(1);
      // First call sizes the buffer and is EXPECTED to fail; only the second one's result is checked.
      advapi32.symbols.GetTokenInformation(
        token as never, informationClass, null as never, 0, ptr(size) as never,
      );
      if (size[0]! === 0) throw new Error('GetTokenInformation reported no size');
      const buffer = new Uint8Array(size[0]!);
      if (!advapi32.symbols.GetTokenInformation(
        token as never, informationClass, ptr(buffer) as never, buffer.length, ptr(size) as never,
      )) {
        throw new Error('GetTokenInformation failed');
      }
      // TOKEN_USER and TOKEN_OWNER both begin with the SID pointer.
      return sidToString(Number(new BigUint64Array(buffer.buffer, 0, 1)[0]!));
    } finally {
      kernel32.symbols.CloseHandle(token as never);
    }
  };

  let cachedUserSid: string | undefined;
  let cachedOwnerSid: string | undefined;

  /** Build a self-relative security descriptor from SDDL. The caller frees it. */
  const descriptorFromSddl = (sddl: string): Pointer => {
    const out = new BigUint64Array(1);
    if (!advapi32.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
      ptr(wide(sddl)) as never, SDDL_REVISION_1, ptr(out) as never, null as never,
    )) {
      throw new Error('the owner-only security descriptor could not be built');
    }
    return readPointer(out);
  };

  const daclOf = (descriptor: Pointer): Pointer => {
    const present = new Uint32Array(1);
    const dacl = new BigUint64Array(1);
    const defaulted = new Uint32Array(1);
    if (!advapi32.symbols.GetSecurityDescriptorDacl(
      descriptor as never, ptr(present) as never, ptr(dacl) as never, ptr(defaulted) as never,
    )) {
      throw new Error('GetSecurityDescriptorDacl failed');
    }
    if (!present[0]) throw new Error('the owner-only security descriptor carries no DACL');
    return readPointer(dacl);
  };

  const aceTypeName = (type: number): 'Allow' | 'Deny' | 'Other' => {
    if (type === ACCESS_ALLOWED_ACE_TYPE) return 'Allow';
    if (type === ACCESS_DENIED_ACE_TYPE) return 'Deny';
    // Anything else -- an object ACE, a callback ACE -- is neither, and must never be read as Allow.
    return 'Other';
  };

  const readDacl = (dacl: Pointer): WindowsAceSnapshot[] => {
    if (!dacl) {
      // A NULL DACL grants everyone everything. It is reported as one unreadable entry rather than
      // as an empty list, which a caller would read as "no access granted" -- the exact inverse.
      throw new Error('the path has a NULL DACL, which grants full access to everyone');
    }
    // ACL { BYTE AclRevision; BYTE Sbz1; WORD AclSize; WORD AceCount; WORD Sbz2; }
    const header = new DataView(toArrayBuffer(dacl as never, 0, 8));
    const count = header.getUint16(4, true);
    const aces: WindowsAceSnapshot[] = [];
    for (let index = 0; index < count; index += 1) {
      const out = new BigUint64Array(1);
      if (!advapi32.symbols.GetAce(dacl as never, index, ptr(out) as never)) {
        throw new Error(`GetAce failed at index ${index}`);
      }
      const ace = readPointer(out);
      // ACE_HEADER { BYTE AceType; BYTE AceFlags; WORD AceSize; } then ACCESS_MASK, then the SID.
      const view = new DataView(toArrayBuffer(ace as never, 0, 8));
      const type = view.getUint8(0);
      const flags = view.getUint8(1);
      const rights = view.getUint32(4, true);
      aces.push({
        sid: sidToString(ace + 8),
        type: aceTypeName(type),
        rights,
        inherited: (flags & INHERITED_ACE) !== 0,
        inheritanceFlags:
          ((flags & CONTAINER_INHERIT_ACE) !== 0 ? 1 : 0) | ((flags & OBJECT_INHERIT_ACE) !== 0 ? 2 : 0),
        propagationFlags:
          ((flags & NO_PROPAGATE_INHERIT_ACE) !== 0 ? 1 : 0) | ((flags & INHERIT_ONLY_ACE) !== 0 ? 2 : 0),
      });
    }
    return aces;
  };

  const readSecurity = (path: string): WindowsSecuritySnapshot => {
    const owner = new BigUint64Array(1);
    const dacl = new BigUint64Array(1);
    const descriptor = new BigUint64Array(1);
    const status = advapi32.symbols.GetNamedSecurityInfoW(
      ptr(wide(path)) as never, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      ptr(owner) as never, null as never, ptr(dacl) as never, null as never, ptr(descriptor) as never,
    );
    if (status !== 0) throw new Error(`the path's security could not be read (Windows error ${status})`);
    const held = readPointer(descriptor);
    try {
      const control = new Uint16Array(1);
      const revision = new Uint32Array(1);
      if (!advapi32.symbols.GetSecurityDescriptorControl(
        held as never, ptr(control) as never, ptr(revision) as never,
      )) {
        throw new Error('GetSecurityDescriptorControl failed');
      }
      return {
        ownerSid: sidToString(readPointer(owner)),
        protected: (control[0]! & SE_DACL_PROTECTED) !== 0,
        aces: readDacl(readPointer(dacl)),
      };
    } finally {
      kernel32.symbols.LocalFree(held as never);
    }
  };

  return {
    currentUserSid: () => (cachedUserSid ??= tokenSid(TOKEN_USER_CLASS)),
    currentTokenOwnerSid: () => (cachedOwnerSid ??= tokenSid(TOKEN_OWNER_CLASS)),

    nativeMachine: () => {
      const processMachine = new Uint16Array(1);
      const nativeMachine = new Uint16Array(1);
      const ok = kernel32.symbols.IsWow64Process2(
        kernel32.symbols.GetCurrentProcess(), ptr(processMachine) as never, ptr(nativeMachine) as never,
      );
      if (!ok) return 'unknown';
      switch (nativeMachine[0]) {
        case IMAGE_FILE_MACHINE_AMD64: return 'x64';
        case IMAGE_FILE_MACHINE_ARM64: return 'arm64';
        // Zero means the call succeeded and declined to say, which is not a machine we have qualified
        // and not a machine we can name either.
        case IMAGE_FILE_MACHINE_UNKNOWN: return 'unknown';
        default: return 'other';
      }
    },

    readSecurity,

    pathOwnerSid: (path: string): string => {
      const owner = new BigUint64Array(1);
      const descriptor = new BigUint64Array(1);
      const status = advapi32.symbols.GetNamedSecurityInfoW(
        ptr(wide(path)) as never, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
        ptr(owner) as never, null as never, null as never, null as never, ptr(descriptor) as never,
      );
      if (status !== 0) throw new Error(`the path's owner could not be read (Windows error ${status})`);
      const held = readPointer(descriptor);
      try {
        return sidToString(readPointer(owner));
      } finally {
        kernel32.symbols.LocalFree(held as never);
      }
    },

    applySecurity: (path: string, sddl: string): void => {
      const descriptor = descriptorFromSddl(sddl);
      try {
        const owner = new BigUint64Array(1);
        const defaulted = new Uint32Array(1);
        if (!advapi32.symbols.GetSecurityDescriptorOwner(
          descriptor as never, ptr(owner) as never, ptr(defaulted) as never,
        )) {
          throw new Error('GetSecurityDescriptorOwner failed');
        }
        // Owner and DACL in ONE call. Two calls would leave a window in which the object is owned by
        // the user and still carrying inherited access, or protected and still owned by somebody else.
        const status = advapi32.symbols.SetNamedSecurityInfoW(
          ptr(wide(path)) as never, SE_FILE_OBJECT,
          (OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION) >>> 0,
          readPointer(owner) as never, null as never, daclOf(descriptor) as never, null as never,
        );
        if (status !== 0) {
          throw new Error(`owner-only access could not be applied (Windows error ${status})`);
        }
      } finally {
        kernel32.symbols.LocalFree(descriptor as never);
      }
    },

    processCommandLine: (pid: number): string | null => {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new Error('invalid process id');
      const handle = kernel32.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!handle) {
        const error = kernel32.symbols.GetLastError();
        if (error === ERROR_INVALID_PARAMETER) return null;
        throw new Error(`the process could not be opened (Windows error ${error})`);
      }
      try {
        const query = ntQuery();
        const returned = new Uint32Array(1);
        let size = 4096;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const buffer = new Uint8Array(size);
          const base = ptr(buffer);
          const status = query(
            handle as never, PROCESS_COMMAND_LINE_INFORMATION as never, base as never, size as never, ptr(returned) as never,
          ) | 0;
          if (status === 0) {
            // UNICODE_STRING { USHORT Length; USHORT MaximumLength; PWSTR Buffer; }, its text after it
            // in the same buffer. The pointer is checked to land inside what was handed over.
            const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            const length = view.getUint16(0, true);
            if (length === 0) return '';
            const offset = Number(view.getBigUint64(8, true) - BigInt(base));
            if (!Number.isSafeInteger(offset) || offset < 16 || offset + length > size) {
              throw new Error('the command line came back outside its buffer');
            }
            return Buffer.from(buffer.buffer, buffer.byteOffset + offset, length).toString('utf16le');
          }
          // Exited, but its process object outlives it while any handle (its parent's) is open.
          if (status === STATUS_PROCESS_IS_TERMINATING) return null;
          const needed = returned[0]!;
          if (!STATUS_RESIZE.has(status) || needed <= size || needed > COMMAND_LINE_MAX_BYTES) {
            throw new Error(`the command line could not be read (NTSTATUS 0x${(status >>> 0).toString(16)})`);
          }
          size = needed;
        }
        throw new Error('the command line kept growing while it was read');
      } finally {
        kernel32.symbols.CloseHandle(handle as never);
      }
    },

    processTable: (): WindowsProcessTableEntry[] => {
      const api = (processList ??= openProcessList());
      // Taken BEFORE the list, so a start read afterwards can be checked against it (see
      // `windowsProcessStart`). A process created between this and the list loses only its start.
      const clock = new BigUint64Array(1);
      api.GetSystemTimeAsFileTime(ptr(clock) as never);
      const listedAt = clock[0]!;
      const snapshot = BigInt(api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
      if (snapshot === -1n || snapshot === 0n) {
        throw new Error(`the process list could not be taken (Windows error ${kernel32.symbols.GetLastError()})`);
      }
      const listed: Array<{ pid: number; parentPid: number; name: string }> = [];
      try {
        const entry = new Uint8Array(PROCESSENTRY32W_SIZE);
        new DataView(entry.buffer).setUint32(0, PROCESSENTRY32W_SIZE, true);
        for (
          let more = api.Process32FirstW(snapshot, ptr(entry) as never);
          more;
          more = api.Process32NextW(snapshot, ptr(entry) as never)
        ) {
          if (listed.length >= PROCESS_TABLE_MAX) throw new Error('the process list did not end');
          listed.push(readProcessEntry32W(entry));
        }
        // Anything but the end of the list is a list cut short, and a short list could leave out
        // exactly the process a caller is asking about.
        const error = kernel32.symbols.GetLastError();
        if (error !== ERROR_NO_MORE_FILES) throw new Error(`the process list stopped early (Windows error ${error})`);
      } finally {
        api.CloseHandle(snapshot);
      }
      // FILETIME creation, exit, kernel and user times; only the first is read.
      const times = new BigUint64Array(4);
      const startOf = (pid: number): string => {
        const handle = kernel32.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (!handle) return '';
        try {
          times.fill(0n);
          const base = ptr(times);
          if (!api.GetProcessTimes(
            handle as never, base as never, (base + 8) as never, (base + 16) as never, (base + 24) as never,
          )) {
            return '';
          }
          return windowsProcessStart(times[0]!, listedAt);
        } finally {
          kernel32.symbols.CloseHandle(handle as never);
        }
      };
      return listed
        .filter((entry) => entry.pid > 0)
        .map((entry) => ({ ...entry, start: startOf(entry.pid) }));
    },

    createDirectory: (path: string, sddl: string): void => {
      const descriptor = descriptorFromSddl(sddl);
      try {
        // SECURITY_ATTRIBUTES { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle; }
        const attributes = new ArrayBuffer(24);
        const view = new DataView(attributes);
        view.setUint32(0, 24, true);
        view.setBigUint64(8, BigInt(descriptor), true);
        view.setUint32(16, 0, true);
        // Created WITH its descriptor, never created and then tightened: a directory that exists for
        // even an instant carrying its parent's inherited access is a directory somebody else could
        // have read, and no later call can take that back.
        if (!kernel32.symbols.CreateDirectoryW(
          ptr(wide(path)) as never, ptr(new Uint8Array(attributes)) as never,
        )) {
          const error = kernel32.symbols.GetLastError();
          // Losing the race is not a failure. Several brokers starting at once each create the state
          // directory, one wins, and the rest get ERROR_ALREADY_EXISTS -- which is why the .NET call
          // this replaced accepted an existing directory too. Nothing is relaxed by accepting it: the
          // caller reads the directory's ACL back and classifies it, so one created by somebody else,
          // or left over with inherited access, still fails there. What must NOT happen is creating
          // it unprotected and tightening afterwards, and this path never does.
          if (error !== ERROR_ALREADY_EXISTS) {
            throw new Error(`the owner-only directory could not be created (Windows error ${error})`);
          }
        }
      } finally {
        kernel32.symbols.LocalFree(descriptor as never);
      }
    },
  };
}
