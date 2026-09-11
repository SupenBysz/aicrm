import "./desktop-offline";
import { exposeBridge } from "./bridge";
import { installDesktopWindowChrome } from "./window-chrome";

exposeBridge();
installDesktopWindowChrome();
