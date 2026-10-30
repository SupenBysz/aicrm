import React from "react";
import {createRoot} from "react-dom/client";
import {PublicDocumentsApp} from "./public-documents-app";
createRoot(document.getElementById("root")!).render(<React.StrictMode><PublicDocumentsApp/></React.StrictMode>);
