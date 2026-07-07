import { Card, Space, Typography } from "antd";
import type { ReactNode } from "react";

export const drawerWidths = {
  compactForm: "min(480px, 96vw)",
  simpleDetail: "min(560px, 96vw)",
  standardForm: "min(640px, 96vw)",
  wideList: "min(760px, 96vw)",
  complexDetail: "min(900px, 96vw)"
} as const;

interface ListPageCardProps {
  title: string;
  extra?: ReactNode;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  /** @deprecated use toolbar for list-level filters/actions. */
  titleCenter?: ReactNode;
  children: ReactNode;
}

function ListTitleBlock({ subtitle, title }: { title: string; subtitle?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      {subtitle ? (
        typeof subtitle === "string" ? (
          <Typography.Text type="secondary">{subtitle}</Typography.Text>
        ) : (
          subtitle
        )
      ) : null}
    </div>
  );
}

export function ListPageCard({ title, extra, subtitle, toolbar, titleCenter, children }: ListPageCardProps) {
  const listToolbar = toolbar ?? titleCenter;
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <div
        style={{
          alignItems: "flex-end",
          columnGap: 16,
          display: "flex",
          justifyContent: "space-between",
          width: "100%"
        }}
      >
        <div style={{ minWidth: 0 }}>
          <ListTitleBlock title={title} subtitle={subtitle} />
        </div>
        {extra ? <div style={{ flex: "0 0 auto", marginLeft: "auto" }}>{extra}</div> : null}
      </div>
      <Card
        styles={{ body: { padding: 0 }, header: { paddingInline: 16 } }}
        title={
          listToolbar ? (
            <div
              style={{
                alignItems: "center",
                display: "flex",
                justifyContent: "flex-start",
                overflowX: "auto",
                width: "100%"
              }}
            >
              {listToolbar}
            </div>
          ) : undefined
        }
      >
        {children}
      </Card>
    </Space>
  );
}

interface DetailPagePanelProps {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}

export function DetailPagePanel({ title, extra, children }: DetailPagePanelProps) {
  return (
    <Card extra={extra} title={title}>
      {children}
    </Card>
  );
}
