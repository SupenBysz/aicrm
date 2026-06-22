import { useEffect, useState } from "react";
import { Button, Form, Select, Skeleton, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DetailPagePanel, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  getDefaultModels,
  listAllModels,
  updateDefaultModels,
  type DefaultModelSettings
} from "../api";

export function DefaultModelsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<DefaultModelSettings>();
  const [touched, setTouched] = useState(false);

  const canUpdate = permissions.can("platform.ai_model_settings.update");

  const settingsQuery = useQuery({ queryKey: ["ai-default-models"], queryFn: () => getDefaultModels(client) });
  const modelsQuery = useQuery({ queryKey: ["ai-models", "all"], queryFn: () => listAllModels(client) });

  const enabledModels = (modelsQuery.data?.items ?? []).filter((m) => m.status === "enabled");
  const textOptions = enabledModels
    .filter((m) => m.modelType === "text_generation")
    .map((m) => ({ value: m.id, label: m.name }));
  const embeddingOptions = enabledModels
    .filter((m) => m.modelType === "embedding")
    .map((m) => ({ value: m.id, label: m.name }));

  useEffect(() => {
    if (settingsQuery.data && !touched) {
      form.setFieldsValue({
        defaultChatModelId: settingsQuery.data.defaultChatModelId ?? undefined,
        defaultSummaryModelId: settingsQuery.data.defaultSummaryModelId ?? undefined,
        defaultEmbeddingModelId: settingsQuery.data.defaultEmbeddingModelId ?? undefined
      });
    }
  }, [settingsQuery.data, form, touched]);

  const saveMutation = useMutation({
    mutationFn: (values: DefaultModelSettings) =>
      updateDefaultModels(client, {
        defaultChatModelId: values.defaultChatModelId ?? null,
        defaultSummaryModelId: values.defaultSummaryModelId ?? null,
        defaultEmbeddingModelId: values.defaultEmbeddingModelId ?? null
      }),
    onSuccess: () => {
      void message.success("默认模型已保存。");
      queryClient.invalidateQueries({ queryKey: ["ai-default-models"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  const loading = settingsQuery.isLoading || modelsQuery.isLoading;

  return (
    <DetailPagePanel
      title="默认模型"
      extra={
        canUpdate ? (
          <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
            保存
          </Button>
        ) : null
      }
    >
      {loading ? (
        <Skeleton active />
      ) : (
        <Form<DefaultModelSettings>
          form={form}
          layout="vertical"
          disabled={!canUpdate}
          style={{ maxWidth: 480 }}
          onValuesChange={() => setTouched(true)}
          onFinish={(values) => saveMutation.mutate(values)}
        >
          <Typography.Paragraph type="secondary">为平台选择默认使用的模型（仅可选启用中的模型）。</Typography.Paragraph>
          <Form.Item label="默认对话模型" name="defaultChatModelId">
            <Select allowClear placeholder="选择文本生成模型" options={textOptions} />
          </Form.Item>
          <Form.Item label="默认摘要模型" name="defaultSummaryModelId">
            <Select allowClear placeholder="选择文本生成模型" options={textOptions} />
          </Form.Item>
          <Form.Item label="默认嵌入模型" name="defaultEmbeddingModelId">
            <Select allowClear placeholder="选择向量嵌入模型" options={embeddingOptions} />
          </Form.Item>
        </Form>
      )}
    </DetailPagePanel>
  );
}
