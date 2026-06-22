import { Button, Result } from "antd";
import { useNavigate } from "react-router-dom";

export function NoWorkspacePage() {
  const navigate = useNavigate();
  return (
    <div className="center-shell">
      <Result
        status="warning"
        title="当前账号暂无可进入的后台身份"
        subTitle="请联系管理员邀请加入平台、机构或企业。"
        extra={
          <Button type="primary" onClick={() => navigate("/login")}>
            返回登录
          </Button>
        }
      />
    </div>
  );
}
