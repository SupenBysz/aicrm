import { execFile } from "node:child_process";
import path from "node:path";

/**
 * This adapter installs and verifies a durable read-only ACL fence. It is not
 * an OS isolation boundary against an untrusted process running under the same
 * owner SID: a Windows owner may rewrite its DACL through WRITE_DAC. Launching
 * an App Server therefore still requires the separately reviewed restricted
 * token/AppContainer gate; ACL validation only detects drift and blocks normal
 * filesystem writes from being accepted as an immutable credential revision.
 */
export interface DesktopWindowsCredentialProtection {
  ensurePrivateDirectory(directory: string): Promise<void>;
  syncFile(file: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
  syncMutableTree(root: string): Promise<void>;
  sealReadOnlyTree(root: string): Promise<void>;
  validateReadOnlyTree(root: string): Promise<void>;
  prepareReadOnlyTreeForMove(root: string): Promise<void>;
  sealQuarantineReservation(reservation: string, payload: string): Promise<void>;
}

export class DesktopWindowsCredentialProtectionError extends Error {
  constructor(message = "Windows credential protection failed") {
    super(message);
  }
}

const WINDOWS_PROTECTION_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class AiCRMCredentialNative {
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string name,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(SafeFileHandle handle);

    public static SafeFileHandle OpenForFlush(string name, bool directory) {
        uint flags = FILE_FLAG_OPEN_REPARSE_POINT;
        if (directory) flags |= FILE_FLAG_BACKUP_SEMANTICS;
        SafeFileHandle handle = CreateFileW(
            name,
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            flags,
            IntPtr.Zero);
        if (handle == null || handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            if (handle != null) handle.Dispose();
            throw new Win32Exception(error, "credential path cannot be opened for a durable flush");
        }
        return handle;
    }

    public static void Flush(SafeFileHandle handle) {
        if (!FlushFileBuffers(handle)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "credential path durable flush failed");
        }
    }
}
"@

$script:CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$script:SystemSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
if ($null -eq $script:CurrentSid -or $script:CurrentSid.Value -eq $script:SystemSid.Value) {
    throw "unsupported credential owner"
}

function Assert-NotReparse([System.IO.FileSystemInfo] $Item) {
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "credential reparse points are forbidden"
    }
}

function Get-CredentialTree([string] $Root) {
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (-not $rootItem.PSIsContainer) { throw "credential tree root must be a directory" }
    $items = New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
    function Visit-CredentialItem([System.IO.FileSystemInfo] $Item) {
        Assert-NotReparse $Item
        $items.Add($Item)
        if ($Item.PSIsContainer) {
            foreach ($child in @(Get-ChildItem -LiteralPath $Item.FullName -Force | Sort-Object -Property Name)) {
                Visit-CredentialItem $child
            }
        }
    }
    Visit-CredentialItem $rootItem
    return $items.ToArray()
}

function New-ReadonlySecurity([bool] $Directory) {
    if ($Directory) {
        $security = New-Object System.Security.AccessControl.DirectorySecurity
    } else {
        $security = New-Object System.Security.AccessControl.FileSecurity
    }
    $security.SetOwner($script:CurrentSid)
    $security.SetAccessRuleProtection($true, $false)
    $none = [System.Security.AccessControl.InheritanceFlags]::None
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $userRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $script:CurrentSid,
        [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
        $none,
        $propagation,
        $allow)
    $systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $script:SystemSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $none,
        $propagation,
        $allow)
    [void]$security.AddAccessRule($userRule)
    [void]$security.AddAccessRule($systemRule)
    return $security
}

function New-PrivateDirectorySecurity() {
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($script:CurrentSid)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    foreach ($sid in @($script:CurrentSid, $script:SystemSid)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            $propagation,
            $allow)
        [void]$security.AddAccessRule($rule)
    }
    return $security
}

function Set-ReadonlyItem([System.IO.FileSystemInfo] $Item) {
    Assert-NotReparse $Item
    if (-not $Item.PSIsContainer) {
        $Item.Attributes = $Item.Attributes -bor [System.IO.FileAttributes]::ReadOnly
        $Item.Refresh()
    }
    $Item.SetAccessControl((New-ReadonlySecurity $Item.PSIsContainer))
    $Item.Refresh()
}

function Test-ExpectedRule(
    [System.Security.AccessControl.FileSystemAccessRule] $Rule,
    [System.Security.Principal.SecurityIdentifier] $Sid,
    [System.Security.AccessControl.FileSystemRights] $Rights,
    [System.Security.AccessControl.InheritanceFlags] $Inheritance) {
    return $Rule.IdentityReference.Value -eq $Sid.Value -and $Rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and -not $Rule.IsInherited -and [int64]$Rule.FileSystemRights -eq [int64]$Rights -and [int]$Rule.InheritanceFlags -eq [int]$Inheritance -and $Rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None
}

function Assert-ExactSecurity(
    [System.IO.FileSystemInfo] $Item,
    [System.Security.AccessControl.FileSystemRights] $UserRights,
    [System.Security.AccessControl.InheritanceFlags] $Inheritance) {
    Assert-NotReparse $Item
    $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
    $security = $Item.GetAccessControl($sections)
    if (-not $security.AreAccessRulesProtected) { throw "credential ACL inherits permissions" }
    $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $script:CurrentSid.Value) { throw "credential ACL owner drifted" }
    $rules = @($security.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw "credential ACL rule count drifted" }
    $userMatches = @($rules | Where-Object {
        Test-ExpectedRule $_ $script:CurrentSid $UserRights $Inheritance
    })
    $systemMatches = @($rules | Where-Object {
        Test-ExpectedRule $_ $script:SystemSid ([System.Security.AccessControl.FileSystemRights]::FullControl) $Inheritance
    })
    if ($userMatches.Count -ne 1 -or $systemMatches.Count -ne 1) {
        throw "credential ACL rule drifted"
    }
}

function Assert-ReadonlyItem([System.IO.FileSystemInfo] $Item) {
    Assert-ExactSecurity $Item ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) ([System.Security.AccessControl.InheritanceFlags]::None)
    if (-not $Item.PSIsContainer -and ($Item.Attributes -band [System.IO.FileAttributes]::ReadOnly) -eq 0) {
        throw "credential file is not marked read-only"
    }
}

function Assert-ReadonlyTree([string] $Root) {
    foreach ($item in @(Get-CredentialTree $Root)) { Assert-ReadonlyItem $item }
}

function Invoke-EnsurePrivateDirectory([string] $Target) {
    $item = Get-Item -LiteralPath $Target -Force
    if (-not $item.PSIsContainer) { throw "private credential path must be a directory" }
    Assert-NotReparse $item
    try {
        $item.SetAccessControl((New-PrivateDirectorySecurity))
        $item.Refresh()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        Assert-ExactSecurity $item ([System.Security.AccessControl.FileSystemRights]::FullControl) $inheritance
        $handle = [AiCRMCredentialNative]::OpenForFlush($item.FullName, $true)
        try {
            [AiCRMCredentialNative]::Flush($handle)
        } finally {
            $handle.Dispose()
        }
    } catch {
        try { $item.SetAccessControl((New-PrivateDirectorySecurity)) } catch { }
        throw
    }
}

function Invoke-SyncPath([string] $Target, [bool] $Directory) {
    $item = Get-Item -LiteralPath $Target -Force
    Assert-NotReparse $item
    if ($item.PSIsContainer -ne $Directory) { throw "credential durable path kind mismatch" }
    $handle = [AiCRMCredentialNative]::OpenForFlush($item.FullName, $Directory)
    try {
        [AiCRMCredentialNative]::Flush($handle)
    } finally {
        $handle.Dispose()
    }
}

function Invoke-SyncMutableTree([string] $Root) {
    $items = @(Get-CredentialTree $Root)
    $ordered = @($items | Sort-Object @{ Expression = { $_.PSIsContainer }; Ascending = $true }, @{ Expression = { $_.FullName.Length }; Descending = $true })
    foreach ($item in $ordered) {
        $handle = [AiCRMCredentialNative]::OpenForFlush($item.FullName, $item.PSIsContainer)
        try {
            [AiCRMCredentialNative]::Flush($handle)
        } finally {
            $handle.Dispose()
        }
    }
}

function Invoke-SealTree([string] $Root) {
    $items = @(Get-CredentialTree $Root)
    $handles = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
    try {
        foreach ($item in $items) {
            $handles.Add([AiCRMCredentialNative]::OpenForFlush($item.FullName, $item.PSIsContainer))
        }
        foreach ($item in @($items | Sort-Object { $_.FullName.Length } -Descending)) {
            Set-ReadonlyItem $item
        }
        foreach ($item in $items) { Assert-ReadonlyItem $item }
        foreach ($handle in $handles) { [AiCRMCredentialNative]::Flush($handle) }
    } catch {
        foreach ($item in @($items | Sort-Object { $_.FullName.Length } -Descending)) {
            try { Set-ReadonlyItem $item } catch { }
        }
        throw
    } finally {
        foreach ($handle in $handles) { $handle.Dispose() }
    }
}

function Invoke-SealQuarantine([string] $Reservation, [string] $Payload) {
    $reservationItem = Get-Item -LiteralPath $Reservation -Force
    $payloadItem = Get-Item -LiteralPath $Payload -Force
    if (-not $reservationItem.PSIsContainer -or -not $payloadItem.PSIsContainer) {
        throw "credential quarantine shape is invalid"
    }
    Assert-NotReparse $reservationItem
    Assert-NotReparse $payloadItem
    $expectedPayload = [System.IO.Path]::GetFullPath((Join-Path $reservationItem.FullName "payload"))
    if (-not $expectedPayload.Equals($payloadItem.FullName, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "credential quarantine payload escaped its reservation"
    }
    $children = @(Get-ChildItem -LiteralPath $reservationItem.FullName -Force)
    if ($children.Count -ne 1 -or $children[0].FullName -ne $payloadItem.FullName) {
        throw "credential quarantine reservation contains unexpected entries"
    }
    Assert-ReadonlyTree $payloadItem.FullName
    $handle = [AiCRMCredentialNative]::OpenForFlush($reservationItem.FullName, $true)
    try {
        Set-ReadonlyItem $reservationItem
        Assert-ReadonlyItem $reservationItem
        Assert-ReadonlyTree $payloadItem.FullName
        [AiCRMCredentialNative]::Flush($handle)
    } catch {
        try { Set-ReadonlyItem $reservationItem } catch { }
        throw
    } finally {
        $handle.Dispose()
    }
}

$action = $env:AICRM_CREDENTIAL_ACTION
$target = $env:AICRM_CREDENTIAL_TARGET
if ([string]::IsNullOrWhiteSpace($action) -or [string]::IsNullOrWhiteSpace($target)) {
    throw "credential protection input is missing"
}

switch ($action) {
    "ensure_private_directory" { Invoke-EnsurePrivateDirectory $target }
    "sync_file" { Invoke-SyncPath $target $false }
    "sync_directory" { Invoke-SyncPath $target $true }
    "sync_mutable_tree" { Invoke-SyncMutableTree $target }
    "seal_readonly_tree" { Invoke-SealTree $target }
    "validate_readonly_tree" { Assert-ReadonlyTree $target }
    "prepare_readonly_tree_move" { Assert-ReadonlyTree $target }
    "seal_quarantine_reservation" {
        $payload = $env:AICRM_CREDENTIAL_PAYLOAD
        if ([string]::IsNullOrWhiteSpace($payload)) { throw "credential quarantine payload is missing" }
        Invoke-SealQuarantine $target $payload
    }
    default { throw "credential protection action is invalid" }
}

[Console]::Out.Write("OK")
`;

type WindowsProtectionAction =
  | "ensure_private_directory"
  | "sync_file"
  | "sync_directory"
  | "sync_mutable_tree"
  | "seal_readonly_tree"
  | "validate_readonly_tree"
  | "prepare_readonly_tree_move"
  | "seal_quarantine_reservation";

export class PowerShellDesktopWindowsCredentialProtection
  implements DesktopWindowsCredentialProtection
{
  private readonly executable: string;

  constructor(executable = defaultWindowsPowerShellExecutable()) {
    this.executable = executable;
  }

  ensurePrivateDirectory(directory: string): Promise<void> {
    return this.run("ensure_private_directory", directory);
  }

  syncFile(file: string): Promise<void> {
    return this.run("sync_file", file);
  }

  syncDirectory(directory: string): Promise<void> {
    return this.run("sync_directory", directory);
  }

  syncMutableTree(root: string): Promise<void> {
    return this.run("sync_mutable_tree", root);
  }

  sealReadOnlyTree(root: string): Promise<void> {
    return this.run("seal_readonly_tree", root);
  }

  validateReadOnlyTree(root: string): Promise<void> {
    return this.run("validate_readonly_tree", root);
  }

  prepareReadOnlyTreeForMove(root: string): Promise<void> {
    return this.run("prepare_readonly_tree_move", root);
  }

  sealQuarantineReservation(reservation: string, payload: string): Promise<void> {
    return this.run("seal_quarantine_reservation", reservation, payload);
  }

  private run(action: WindowsProtectionAction, target: string, payload?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "-"
        ],
        {
          encoding: "utf8",
          env: {
            ...windowsPowerShellEnvironment(),
            AICRM_CREDENTIAL_ACTION: action,
            AICRM_CREDENTIAL_TARGET: target,
            ...(payload === undefined ? {} : { AICRM_CREDENTIAL_PAYLOAD: payload })
          },
          maxBuffer: 64 << 10,
          timeout: 120_000,
          windowsHide: true
        },
        (error, stdout) => {
          if (error || stdout !== "OK") {
            reject(new DesktopWindowsCredentialProtectionError());
            return;
          }
          resolve();
        }
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(WINDOWS_PROTECTION_SCRIPT, "utf8");
    });
  }
}

export function createDesktopWindowsCredentialProtection(): DesktopWindowsCredentialProtection {
  return new PowerShellDesktopWindowsCredentialProtection();
}

function defaultWindowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

function windowsPowerShellEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "SystemDrive",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "windir"
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.SystemRoot ??= "C:\\Windows";
  environment.windir ??= environment.SystemRoot;
  return environment;
}
