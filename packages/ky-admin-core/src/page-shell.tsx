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
  children: ReactNode;
}

export function ListPageCard({ title, extra, subtitle, children }: ListPageCardProps) {
  return (
    <Card
      extra={extra}
      styles={{ body: { padding: 0 } }}
      title={
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{title}</Typography.Text>
          {subtitle ? (
            typeof subtitle === "string" ? (
              <Typography.Text type="secondary">{subtitle}</Typography.Text>
            ) : (
              subtitle
            )
          ) : null}
        </Space>
      }
    >
      {children}
    </Card>
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
