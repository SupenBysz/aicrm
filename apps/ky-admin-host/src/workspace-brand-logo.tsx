import { BrandLogoLockup } from "@ky/admin-core";
import { useEffect, useLayoutEffect, useState } from "react";
import { requestClient } from "./remote-api";
import { usePlatformProfile } from "./platform-profile";
interface Brand {
  showAiIcon?: boolean;
  iconText?: string;
  name: string;
  applicationName: string;
  wordmarkGenerated?: boolean;
  wordmark?: {
    url: string;
  };
  effectiveFingerprint: string;
}
export function WorkspaceBrandLogo({
  workspace,
  collapsed,
}: {
  workspace: {
    id: string;
    type: string;
    membershipId: string;
  };
  collapsed: boolean;
}) {
  const p = usePlatformProfile(),
    key = `${workspace.type}:${workspace.id}:${workspace.membershipId}`;
  const [resolved, setResolved] = useState<{
      key: string;
      brand?: Brand;
      error?: boolean;
    }>(),
    [retry, setRetry] = useState(0),
    [broken, setBroken] = useState("");
  useEffect(() => {
    const refresh = () => setRetry((x) => x + 1);
    window.addEventListener("ky:agency-branding-updated", refresh);
    window.addEventListener("ky:platform-profile-updated", refresh);
    return () => {
      window.removeEventListener("ky:agency-branding-updated", refresh);
      window.removeEventListener("ky:platform-profile-updated", refresh);
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (workspace.type === "platform") return;
    void requestClient
      .request<{
        brand: Brand;
      }>("/api/v1/organizations/current/branding")
      .then((v) => {
        if (active) setResolved({ key, brand: v.brand });
      })
      .catch(() => {
        if (active) setResolved({ key, error: true });
      });
    return () => {
      active = false;
    };
  }, [key, retry, workspace.type]);
  const brand = workspace.type === "platform" ? {
 name: p.logoTextLong, applicationName:p.brand?.applicationName || p.logoTextLong,
 iconText:p.brand?.iconText, showAiIcon:p.brand?.showAiIcon,
 wordmarkGenerated:p.brand?.wordmarkGenerated,
 wordmark:p.brand?.wordmarkId ? {url:"/api/v1/public/platform-brand-assets/"+encodeURIComponent(p.brand.wordmarkId)} : undefined,
 effectiveFingerprint:"platform"
 } : resolved?.key === key ? resolved.brand : undefined;
  const name =
    workspace.type === "platform"
      ? p.ready
        ? p.logoTextLong
        : ""
      : brand?.name;
  useLayoutEffect(() => {
    document.title = name
      ? `${brand?.applicationName || name} 后台`
      : "管理后台";
    return () => {
      document.title = "管理后台";
    };
  }, [name, brand?.applicationName, key]);
  if (!name)
    return (
      <span role="status">
        {workspace.type === "platform" && p.error ? (
          <button onClick={p.refresh}>重试加载品牌</button>
        ) : resolved?.key === key && resolved.error ? (
          <button onClick={() => setRetry((x) => x + 1)}>重试加载品牌</button>
        ) : (
          "加载中"
        )}
      </span>
    );
  const url = brand?.wordmark?.url;
  return (
    <BrandLogoLockup compactInset={collapsed ? 0 : 6} showAIIcon={!collapsed && brand?.showAiIcon === true} maxHeight={40}>
      {url && broken !== url && !collapsed ? (
        <img
          src={url}
          alt={name}
          style={{
            maxHeight: 40,
            maxWidth: brand?.showAiIcon ? "calc(100% - 37px)" : "100%",
            objectFit: "contain",
            ...(brand?.wordmarkGenerated
              ? { filter: "var(--brand-generated-filter,none)" }
              : {}),
          }}
          onError={() => setBroken(url)}
        />
      ) : collapsed ? (
        workspace.type === "platform" ? (
          p.logoTextShort
        ) : (
          brand?.iconText || Array.from(name).slice(0, 2).join("")
        )
      ) : (
        name
      )}
    </BrandLogoLockup>
  );
}
