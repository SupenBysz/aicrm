import { app } from "electron";
import { join } from "node:path";
import { FileProtectedStorage } from "./file-protected-storage";
let storage: FileProtectedStorage | undefined;
/** Separate namespace: never reads, decrypts, overwrites or migrates OS-backed files. */
export const localCredentialRoot = () => join(app.getPath("userData"), "local-credentials-v1");
export const localCredentialStorage = {
    isEncryptionAvailable: () => get().isEncryptionAvailable(),
    getSelectedStorageBackend: () => "local_file_aes256_gcm",
    encryptString: (value: string) => get().encryptString(value),
    decryptString: (value: Buffer) => get().decryptString(value)
};
function get() { return storage ??= new FileProtectedStorage(localCredentialRoot()); }
