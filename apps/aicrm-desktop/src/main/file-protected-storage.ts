import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants, chmodSync, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SafeStorageLike } from "./desktop-device-identity.ts";
const MAGIC = Buffer.from("KYCRM-LOCAL-AES256GCM-V1\n");
/** Main-only local encryption. No Electron safeStorage, OS keychain or fallback plaintext. */
export class FileProtectedStorage implements SafeStorageLike {
    private key: Buffer | undefined;
    private root: string;
    constructor(root: string) { this.root = resolve(root); }
    isEncryptionAvailable() { try {
        this.loadKey();
        return true;
    }
    catch {
        return false;
    } }
    getSelectedStorageBackend() { return "local_file_aes256_gcm"; }
    encryptString(value: string) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.loadKey(), iv);
        cipher.setAAD(MAGIC);
        const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
    }
    decryptString(value: Buffer) {
        if (!Buffer.isBuffer(value) || value.length <= MAGIC.length + 28 || !value.subarray(0, MAGIC.length).equals(MAGIC))
            throw Error("unsupported_local_ciphertext_no_keychain_migration");
        const iv = value.subarray(MAGIC.length, MAGIC.length + 12);
        const tag = value.subarray(MAGIC.length + 12, MAGIC.length + 28);
        const decipher = createDecipheriv("aes-256-gcm", this.loadKey(), iv);
        decipher.setAAD(MAGIC);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(value.subarray(MAGIC.length + 28)), decipher.final()]).toString("utf8");
    }
    private loadKey(): Buffer {
        if (this.key)
            return this.key;
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const rootInfo = lstatSync(this.root);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (process.platform !== "win32" && rootInfo.uid !== process.getuid?.()))
            throw Error("unsafe_local_key_directory");
        if (process.platform !== "win32")
            chmodSync(this.root, 0o700);
        const target = join(this.root, "master.key");
        try {
            const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
            try {
                writeFileSync(fd, randomBytes(32));
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
        }
        const fd = openSync(target, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
        try {
            const info = fstatSync(fd);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 32 || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())))
                throw Error("unsafe_local_key_file");
            const key = readFileSync(fd);
            if (key.length !== 32)
                throw Error("invalid_local_key");
            this.key = key;
            return key;
        }
        finally {
            closeSync(fd);
        }
    }
}
