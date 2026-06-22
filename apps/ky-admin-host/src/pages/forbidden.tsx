import { Button, Result } from "antd";
import { useNavigate } from "react-router-dom";

export function ForbiddenPage() {
  const navigate = useNavigate();
  return (
    <div className="center-shell">
      <Result
        status="403"
        title="403"
        subTitle="当前后台身份无权访问该页面。"
        extra={
          <Button type="primary" onClick={() => navigate("/workspace/select")}>
            返回工作区选择
          </Button>
        }
      />
    </div>
  );
}
