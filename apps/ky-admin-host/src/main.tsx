import "antd/dist/reset.css";
import "./styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { installMatrixAccountDesktopPort } from "@ky/admin-core";
import { App } from "./app";
import { matrixAccountDesktopPort } from "./desktop-client";

installMatrixAccountDesktopPort(matrixAccountDesktopPort);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
