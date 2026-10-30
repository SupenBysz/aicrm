import "antd/dist/reset.css";
import "./styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { installAiExecutorDesktopPort, installMatrixAccountDesktopPort } from "@ky/admin-core";

import { aiExecutorDesktopPort, matrixAccountDesktopPort } from "./desktop-client";

installMatrixAccountDesktopPort(matrixAccountDesktopPort);
installAiExecutorDesktopPort(aiExecutorDesktopPort);

const root=ReactDOM.createRoot(document.getElementById("root")!);
if(location.pathname.startsWith("/legal/")) {
 void import("./public-documents-app").then(({PublicDocumentsApp})=>root.render(<React.StrictMode><PublicDocumentsApp/></React.StrictMode>));
} else {
 void import("./app").then(({App})=>root.render(<React.StrictMode><App/></React.StrictMode>));
}
