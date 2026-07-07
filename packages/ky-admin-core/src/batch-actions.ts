export async function runBatchRequests<T>(
  items: T[],
  request: (item: T) => Promise<unknown>,
  failureMessage = "批量操作失败"
): Promise<void> {
  const results = await Promise.allSettled(items.map((item) => request(item)));
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed > 0) {
    throw new Error(`${failureMessage}：${failed}/${items.length} 项失败`);
  }
}
