import type {
  DesktopDeviceIdentityProjection as SharedIdentityProjection,
  DesktopDeviceRegistrationResetInput,
  DesktopDeviceRegistrationRuntimeProjection,
  DesktopSession
} from "../shared/types.ts";
import type {
  DesktopDeviceIdentityProjection,
  DesktopDeviceIdentityStore
} from "./desktop-device-identity.ts";
import type { DesktopDeviceRegistrationClient } from "./desktop-device-registration-client.ts";
import type {
  DesktopDevicePendingRegistration,
  DesktopDevicePendingRegistrationStore
} from "./desktop-device-registration-pending.ts";

export type DesktopDeviceTrustRuntimeErrorCode =
  | "desktop_device_registration_reset_confirmation_required"
  | "desktop_device_registration_reset_forbidden";

export class DesktopDeviceTrustRuntimeError extends Error {
  readonly code: DesktopDeviceTrustRuntimeErrorCode;

  constructor(code: DesktopDeviceTrustRuntimeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface TrustIdentityStore
  extends Pick<DesktopDeviceIdentityStore, "getIdentity" | "resetRegistrationRecovery"> {}

interface TrustPendingStore
  extends Pick<DesktopDevicePendingRegistrationStore, "load" | "clearRegistrationRecovery"> {}

interface TrustRegistrationClient
  extends Pick<DesktopDeviceRegistrationClient, "register" | "cancel"> {}

export interface DesktopDeviceTrustRuntimeOptions {
  identityStore: TrustIdentityStore;
  pendingRegistrationStore: TrustPendingStore;
  registrationClient: TrustRegistrationClient;
  loadHostSession: () => Promise<DesktopSession | null>;
  now?: () => Date;
}

/** Main-owned coordinator. It never returns signers, pending bodies, or Bearer values. */
export class DesktopDeviceTrustRuntime {
  private readonly identityStore: TrustIdentityStore;
  private readonly pendingRegistrationStore: TrustPendingStore;
  private readonly registrationClient: TrustRegistrationClient;
  private readonly loadHostSession: () => Promise<DesktopSession | null>;
  private readonly now: () => Date;
  private generation = 0;
  private ensureInFlight: Promise<DesktopDeviceRegistrationRuntimeProjection> | null = null;
  private state: DesktopDeviceRegistrationRuntimeProjection;

  constructor(options: DesktopDeviceTrustRuntimeOptions) {
    this.identityStore = options.identityStore;
    this.pendingRegistrationStore = options.pendingRegistrationStore;
    this.registrationClient = options.registrationClient;
    this.loadHostSession = options.loadHostSession;
    this.now = options.now ?? (() => new Date());
    this.state = this.project("idle", null, null, false, "设备尚未自动登记");
  }

  getIdentity(): Promise<DesktopDeviceIdentityProjection> {
    return this.identityStore.getIdentity();
  }

  async getRegistrationState(): Promise<DesktopDeviceRegistrationRuntimeProjection> {
    try {
      const identity = await this.identityStore.getIdentity();
      if (identity.registrationStatus === "registered") {
        this.state = this.project(
          "registered",
          identity,
          null,
          this.state.backendRebindRequired,
          this.state.backendRebindRequired
            ? "新设备已登记；旧设备绑定仍需在后台执行 rebind"
            : "设备已安全登记"
        );
      } else if (identity.registrationStatus === "revoked" && this.state.status !== "recovery_required") {
        this.state = this.project(
          "failed",
          identity,
          "desktop_device_already_revoked",
          this.state.backendRebindRequired,
          "设备身份已撤销"
        );
      } else if (this.state.deviceId === null) {
        this.state = this.project(
          this.state.status,
          identity,
          this.state.errorCode,
          this.state.backendRebindRequired,
          this.state.message
        );
      }
    } catch (error) {
      this.recordFailure(error);
    }
    return cloneProjection(this.state);
  }

  ensureRegistration(): Promise<DesktopDeviceRegistrationRuntimeProjection> {
    if (this.ensureInFlight) return this.ensureInFlight;
    const generation = this.generation;
    this.state = this.project(
      "registering",
      identityFromState(this.state),
      null,
      this.state.backendRebindRequired,
      "正在安全登记设备"
    );
    const operation = this.registrationClient
      .register()
      .then((identity) => {
        if (generation === this.generation) {
          this.state = this.project(
            "registered",
            identity,
            null,
            this.state.backendRebindRequired,
            this.state.backendRebindRequired
              ? "新设备已登记；旧设备绑定仍需在后台执行 rebind"
              : "设备已安全登记"
          );
        }
        return cloneProjection(this.state);
      })
      .catch((error: unknown) => {
        if (generation === this.generation) this.recordFailure(error);
        return cloneProjection(this.state);
      });
    this.ensureInFlight = operation;
    void operation.finally(() => {
      if (this.ensureInFlight === operation) this.ensureInFlight = null;
    });
    return operation;
  }

  notifySessionSaved(): void {
    void this.ensureRegistration();
  }

  async resumeAfterStartup(): Promise<DesktopDeviceRegistrationRuntimeProjection> {
    try {
      if (!(await this.loadHostSession())) return this.getRegistrationState();
    } catch (error) {
      this.recordFailure(error);
      return cloneProjection(this.state);
    }
    return this.ensureRegistration();
  }

  cancelAutomaticRegistration(): DesktopDeviceRegistrationRuntimeProjection {
    this.generation += 1;
    this.registrationClient.cancel();
    this.state = this.project(
      "cancelled",
      identityFromState(this.state),
      "desktop_device_registration_cancelled",
      this.state.backendRebindRequired,
      "设备自动登记已取消"
    );
    return cloneProjection(this.state);
  }

  async resetRegistrationRecovery(
    input: unknown
  ): Promise<DesktopDeviceRegistrationRuntimeProjection> {
    if (!isExplicitResetConfirmation(input)) {
      throw runtimeError(
        "desktop_device_registration_reset_confirmation_required",
        "重置设备登记恢复状态需要显式确认"
      );
    }
    if (this.state.status !== "recovery_required") {
      throw runtimeError(
        "desktop_device_registration_reset_forbidden",
        "当前设备不处于登记恢复状态"
      );
    }
    const identity = await this.identityStore.getIdentity();
    if (identity.registrationStatus !== "unregistered") {
      throw runtimeError(
        "desktop_device_registration_reset_forbidden",
        "已登记或已撤销设备禁止本地重置"
      );
    }
    const pending = await this.pendingRegistrationStore.load();
    const previousEnsure = this.ensureInFlight;
    this.generation += 1;
    this.registrationClient.cancel();
    if (previousEnsure) await previousEnsure;
    const replacement = await this.identityStore.resetRegistrationRecovery(
      identity.deviceId,
      () => this.clearPendingForReset(pending, identity.deviceId)
    );
    this.state = this.project(
      "idle",
      replacement,
      null,
      true,
      "已生成新的本地设备身份；旧设备绑定仍需在后台执行 rebind"
    );
    const result = await this.ensureRegistration();
    return {
      ...result,
      backendRebindRequired: true,
      message:
        result.status === "registered"
          ? "新设备已登记；旧设备绑定仍需在后台执行 rebind"
          : "本地身份已重置；旧设备绑定仍需在后台执行 rebind"
    };
  }

  private async clearPendingForReset(
    pending: DesktopDevicePendingRegistration | null,
    currentDeviceId: string
  ): Promise<void> {
    await this.pendingRegistrationStore.clearRegistrationRecovery(
      pending?.deviceId ?? currentDeviceId
    );
  }

  private recordFailure(error: unknown): void {
    const code = safeErrorCode(error);
    const cancelled = code === "desktop_device_registration_cancelled";
    const recoveryRequired = code.includes("registration_recovery_required");
    this.state = this.project(
      cancelled ? "cancelled" : recoveryRequired ? "recovery_required" : "failed",
      identityFromState(this.state),
      code,
      this.state.backendRebindRequired,
      cancelled
        ? "设备自动登记已取消"
        : recoveryRequired
          ? "设备登记需要受控恢复"
          : "设备自动登记失败，可稍后重试"
    );
  }

  private project(
    status: DesktopDeviceRegistrationRuntimeProjection["status"],
    identity: Pick<SharedIdentityProjection, "deviceId" | "registrationStatus"> | null,
    errorCode: string | null,
    backendRebindRequired: boolean,
    message: string
  ): DesktopDeviceRegistrationRuntimeProjection {
    return {
      status,
      deviceId: identity?.deviceId ?? null,
      registrationStatus: identity?.registrationStatus ?? null,
      errorCode,
      updatedAt: this.now().toISOString(),
      backendRebindRequired,
      message
    };
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (/^[a-z][a-z0-9_]{0,127}$/.test(code)) return code;
  }
  return "desktop_device_registration_failed";
}

function identityFromState(
  state: DesktopDeviceRegistrationRuntimeProjection
): Pick<SharedIdentityProjection, "deviceId" | "registrationStatus"> | null {
  if (!state.deviceId || !state.registrationStatus) return null;
  return { deviceId: state.deviceId, registrationStatus: state.registrationStatus };
}

function cloneProjection(
  value: DesktopDeviceRegistrationRuntimeProjection
): DesktopDeviceRegistrationRuntimeProjection {
  return { ...value };
}

function isExplicitResetConfirmation(value: unknown): value is DesktopDeviceRegistrationResetInput {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as { confirm?: unknown }).confirm === true
  );
}

function runtimeError(
  code: DesktopDeviceTrustRuntimeErrorCode,
  message: string
): DesktopDeviceTrustRuntimeError {
  return new DesktopDeviceTrustRuntimeError(code, message);
}
