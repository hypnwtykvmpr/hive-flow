using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const uint PipeAccessDuplex = 0x00000003;
    private const uint FileFlagFirstPipeInstance = 0x00080000;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint PipeTypeByte = 0x00000000;
    private const uint PipeReadModeByte = 0x00000000;
    private const uint PipeWait = 0x00000000;
    private const uint PipeRejectRemoteClients = 0x00000008;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;
    private const int ErrorInsufficientBuffer = 122;

    private static async Task<int> Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "selftest")
        {
            var pipeName = $"hive-flow-peer-cred-{Environment.ProcessId}-{Guid.NewGuid():N}";
            var serverTask = InspectClientOnce(pipeName);
            await using var client = new NamedPipeClientStream(".", NormalizePipeName(pipeName), PipeDirection.InOut, PipeOptions.Asynchronous);
            await client.ConnectAsync(5000);
            Console.WriteLine(await serverTask);
            return 0;
        }

        if (args.Length == 2 && args[0] == "server-once")
        {
            Console.WriteLine(await InspectClientOnce(args[1]));
            return 0;
        }

        if (args.Length == 2 && args[0] == "serve")
        {
            await ServeHolderBridge(args[1]);
            return 0;
        }

        Console.Error.WriteLine("usage: selftest | server-once <pipeName> | serve <pipeName>");
        return 64;
    }

    private static async Task<string> InspectClientOnce(string pipeName)
    {
        var currentSid = CurrentUserSid();
        await using var server = CreateHardenedPipeServer(pipeName, currentSid);
        await server.WaitForConnectionAsync();
        var peer = AuthenticateConnectedClient(server, currentSid);
        return JsonSerializer.Serialize(new
        {
            platform = "win32",
            pid = peer.Pid,
            uid = 0,
            sid = peer.Sid,
            startTime = peer.Pid.ToString(),
        });
    }

    private static async Task ServeHolderBridge(string pipeName)
    {
        var currentSid = CurrentUserSid();
        var normalizedPipeName = NormalizePipeName(pipeName);
        await using var firstServer = CreateHardenedPipeServer(normalizedPipeName, currentSid);
        Console.Out.WriteLine(JsonSerializer.Serialize(new
        {
            type = "ready",
            pipeName = FullPipePath(normalizedPipeName),
            currentSid = currentSid.Value,
        }));
        Console.Out.Flush();

        await HandleHolderClientOrContinue(firstServer, currentSid);
        while (true)
        {
            await using var server = CreateHardenedPipeServer(normalizedPipeName, currentSid);
            await HandleHolderClientOrContinue(server, currentSid);
        }
    }

    private static async Task HandleHolderClientOrContinue(NamedPipeServerStream server, SecurityIdentifier currentSid)
    {
        try
        {
            await HandleHolderClient(server, currentSid);
        }
        catch (IOException error) when (error.Message.Contains("parent closed", StringComparison.OrdinalIgnoreCase))
        {
            throw;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"credential holder Windows named-pipe client rejected: {error.GetType().Name}: {error.Message}");
        }
    }

    private static async Task HandleHolderClient(NamedPipeServerStream server, SecurityIdentifier currentSid)
    {
        await server.WaitForConnectionAsync();
        using var reader = new StreamReader(server);
        await using var writer = new StreamWriter(server) { AutoFlush = true, NewLine = "\n" };
        var peer = AuthenticateConnectedClient(server, currentSid);
        if (!StringComparer.OrdinalIgnoreCase.Equals(peer.Sid, currentSid.Value))
        {
            await writer.WriteLineAsync(JsonSerializer.Serialize(new
            {
                ok = false,
                error = "credential holder same-user SID check failed",
            }));
            return;
        }

        var line = await reader.ReadLineAsync();
        if (line is null)
        {
            await writer.WriteLineAsync(JsonSerializer.Serialize(new
            {
                ok = false,
                error = "credential holder command stream ended before a request",
            }));
            return;
        }

        var id = Guid.NewGuid().ToString("N");
        Console.Out.WriteLine(JsonSerializer.Serialize(new
        {
            type = "request",
            id,
            peer = new
            {
                pid = peer.Pid,
                uid = 0,
                sid = peer.Sid,
                startTime = peer.Pid.ToString(),
            },
            line,
        }));
        Console.Out.Flush();

        var parentLine = await Console.In.ReadLineAsync();
        if (parentLine is null)
        {
            throw new IOException("credential holder parent closed before responding to helper request");
        }
        using var responseDocument = JsonDocument.Parse(parentLine);
        var root = responseDocument.RootElement;
        var responseId = root.GetProperty("id").GetString();
        if (!StringComparer.Ordinal.Equals(id, responseId))
        {
            throw new IOException("credential holder parent response id mismatch");
        }
        await writer.WriteLineAsync(root.GetProperty("response").GetRawText());
    }

    private static NamedPipeServerStream CreateHardenedPipeServer(string pipeName, SecurityIdentifier currentSid)
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(currentSid);
        security.SetGroup(currentSid);
        security.AddAccessRule(new PipeAccessRule(
            currentSid,
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        var descriptor = security.GetSecurityDescriptorBinaryForm();
        var descriptorHandle = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try
        {
            var attributes = new SecurityAttributes
            {
                nLength = Marshal.SizeOf<SecurityAttributes>(),
                lpSecurityDescriptor = descriptorHandle.AddrOfPinnedObject(),
                bInheritHandle = false,
            };
            var handle = CreateNamedPipe(
                FullPipePath(NormalizePipeName(pipeName)),
                PipeAccessDuplex | FileFlagOverlapped | FileFlagFirstPipeInstance,
                PipeTypeByte | PipeReadModeByte | PipeWait | PipeRejectRemoteClients,
                1,
                4096,
                4096,
                0,
                ref attributes);
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateNamedPipe failed for hardened credential holder pipe");
            }
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        }
        finally
        {
            descriptorHandle.Free();
        }
    }

    private static PeerCredential AuthenticateConnectedClient(NamedPipeServerStream server, SecurityIdentifier currentSid)
    {
        if (!GetNamedPipeClientProcessId(server.SafePipeHandle, out var pid))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "GetNamedPipeClientProcessId failed");
        }
        var clientSid = ProcessUserSid(pid);
        if (!StringComparer.OrdinalIgnoreCase.Equals(clientSid, currentSid.Value))
        {
            throw new UnauthorizedAccessException("named pipe client SID does not match current user");
        }
        return new PeerCredential(pid, clientSid);
    }

    private static string ProcessUserSid(uint processId)
    {
        var processHandle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (processHandle == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed for named-pipe client");
        }
        var tokenHandle = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(processHandle, TokenQuery, out tokenHandle))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed for named-pipe client");
            }
            _ = GetTokenInformation(tokenHandle, TokenInformationClass.TokenUser, IntPtr.Zero, 0, out var length);
            if (length <= 0 || Marshal.GetLastWin32Error() != ErrorInsufficientBuffer)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation size probe failed");
            }
            var buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(tokenHandle, TokenInformationClass.TokenUser, buffer, length, out _))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation failed");
                }
                var tokenUser = Marshal.PtrToStructure<TokenUser>(buffer);
                return new SecurityIdentifier(tokenUser.User.Sid).Value;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            if (tokenHandle != IntPtr.Zero) CloseHandle(tokenHandle);
            CloseHandle(processHandle);
        }
    }

    private static SecurityIdentifier CurrentUserSid()
    {
        return WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("current Windows user SID is unavailable");
    }

    private static string NormalizePipeName(string pipeName)
    {
        const string prefix = @"\\.\pipe\";
        var normalized = pipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? pipeName[prefix.Length..]
            : pipeName;
        if (string.IsNullOrWhiteSpace(normalized))
        {
            throw new ArgumentException("named pipe path must include a pipe name", nameof(pipeName));
        }
        return normalized;
    }

    private static string FullPipePath(string pipeName)
    {
        return $@"\\.\pipe\{NormalizePipeName(pipeName)}";
    }

    private readonly record struct PeerCredential(uint Pid, string Sid);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenUser
    {
        public SidAndAttributes User;
    }

    private enum TokenInformationClass
    {
        TokenUser = 1,
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafePipeHandle CreateNamedPipe(
        string lpName,
        uint dwOpenMode,
        uint dwPipeMode,
        uint nMaxInstances,
        uint nOutBufferSize,
        uint nInBufferSize,
        uint nDefaultTimeOut,
        ref SecurityAttributes lpSecurityAttributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr tokenHandle,
        TokenInformationClass tokenInformationClass,
        IntPtr tokenInformation,
        int tokenInformationLength,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
