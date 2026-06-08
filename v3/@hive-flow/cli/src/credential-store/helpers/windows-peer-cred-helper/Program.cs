using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "selftest")
        {
            var pipeName = $"hive-flow-peer-cred-{Environment.ProcessId}-{Guid.NewGuid():N}";
            var currentSid = WindowsIdentity.GetCurrent().User
                ?? throw new InvalidOperationException("current Windows user SID is unavailable");
            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(
                currentSid,
                PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance,
                AccessControlType.Allow));
            await using var server = NamedPipeServerStreamAcl.Create(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                0,
                0,
                security);
            await using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            var connectTask = server.WaitForConnectionAsync();
            await client.ConnectAsync(5000);
            await connectTask;
            if (!GetNamedPipeClientProcessId(server.SafePipeHandle, out var pid))
            {
                throw new InvalidOperationException($"GetNamedPipeClientProcessId failed: {Marshal.GetLastWin32Error()}");
            }
            var sid = currentSid.Value;
            Console.WriteLine($"{{\"platform\":\"win32\",\"pid\":{pid},\"uid\":0,\"sid\":\"{JsonEscape(sid)}\",\"startTime\":\"{pid}\"}}");
            return 0;
        }

        Console.Error.WriteLine("usage: selftest");
        return 64;
    }

    private static string JsonEscape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
}
