using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Windows.Security.Credentials.UI;

internal static class Program
{
    private const int CredTypeGeneric = 1;
    private const int CredPersistLocalMachine = 2;

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 0 || args[0] == "status")
        {
            Console.WriteLine("available");
            return 0;
        }

        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: store|retrieve|delete <target>");
            return 64;
        }

        var command = args[0];
        var target = args[1];

        if (command == "store")
        {
            await RequireUserConsent();
            var base64 = Console.In.ReadToEnd().Trim();
            var encrypted = Protect(Convert.FromBase64String(base64));
            WriteCredential(target, Convert.ToBase64String(encrypted));
            return 0;
        }

        if (command == "retrieve")
        {
            await RequireUserConsent();
            var encoded = ReadCredential(target);
            if (encoded is null) return 2;
            var decrypted = Unprotect(Convert.FromBase64String(encoded));
            Console.WriteLine(Convert.ToBase64String(decrypted));
            return 0;
        }

        if (command == "delete")
        {
            CredDelete(target, CredTypeGeneric, 0);
            return 0;
        }

        Console.Error.WriteLine($"unknown command: {command}");
        return 64;
    }

    private static async Task RequireUserConsent()
    {
        var availability = await UserConsentVerifier.CheckAvailabilityAsync();
        if (availability == UserConsentVerifierAvailability.Available)
        {
            var result = await UserConsentVerifier.RequestVerificationAsync("Hive Flow credential access");
            if (result != UserConsentVerificationResult.Verified)
            {
                throw new InvalidOperationException($"Windows Hello consent denied: {result}");
            }
        }
    }

    private static byte[] Protect(byte[] plaintext)
    {
        var input = DataBlob.FromBytes(plaintext);
        var output = new DataBlob();
        try
        {
            if (!CryptProtectData(ref input, "Hive Flow credential", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref output))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return output.ToBytes();
        }
        finally
        {
            input.Free();
            output.Free();
        }
    }

    private static byte[] Unprotect(byte[] ciphertext)
    {
        var input = DataBlob.FromBytes(ciphertext);
        var output = new DataBlob();
        try
        {
            if (!CryptUnprotectData(ref input, out _, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref output))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return output.ToBytes();
        }
        finally
        {
            input.Free();
            output.Free();
        }
    }

    private static void WriteCredential(string target, string secret)
    {
        var secretBytes = Encoding.Unicode.GetBytes(secret);
        var credential = new NativeCredential
        {
            Type = CredTypeGeneric,
            TargetName = target,
            CredentialBlobSize = (uint)secretBytes.Length,
            CredentialBlob = Marshal.AllocCoTaskMem(secretBytes.Length),
            Persist = CredPersistLocalMachine,
            UserName = Environment.UserName,
        };

        try
        {
            Marshal.Copy(secretBytes, 0, credential.CredentialBlob, secretBytes.Length);
            if (!CredWrite(ref credential, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            if (credential.CredentialBlob != IntPtr.Zero) Marshal.FreeCoTaskMem(credential.CredentialBlob);
        }
    }

    private static string? ReadCredential(string target)
    {
        if (!CredRead(target, CredTypeGeneric, 0, out var credentialPtr))
        {
            return null;
        }

        try
        {
            var credential = Marshal.PtrToStructure<NativeCredential>(credentialPtr);
            var bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return Encoding.Unicode.GetString(bytes);
        }
        finally
        {
            CredFree(credentialPtr);
        }
    }

    [DllImport("Advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWrite(ref NativeCredential userCredential, uint flags);

    [DllImport("Advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("Advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredDelete(string target, int type, int flags);

    [DllImport("Advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    [DllImport("Crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        string? dataDescription,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        int flags,
        ref DataBlob dataOut);

    [DllImport("Crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        out string? dataDescription,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        int flags,
        ref DataBlob dataOut);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        public uint Flags;
        public int Type;
        public string TargetName;
        public string? Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string UserName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Size;
        public IntPtr Data;

        public static DataBlob FromBytes(byte[] bytes)
        {
            var blob = new DataBlob
            {
                Size = bytes.Length,
                Data = Marshal.AllocHGlobal(bytes.Length),
            };
            Marshal.Copy(bytes, 0, blob.Data, bytes.Length);
            return blob;
        }

        public byte[] ToBytes()
        {
            if (Size <= 0 || Data == IntPtr.Zero) return Array.Empty<byte>();
            var bytes = new byte[Size];
            Marshal.Copy(Data, bytes, 0, Size);
            return bytes;
        }

        public void Free()
        {
            if (Data != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(Data);
                Data = IntPtr.Zero;
                Size = 0;
            }
        }
    }
}
