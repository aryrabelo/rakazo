// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
// "Route traffic through this computer" right below "Let bots use this computer"
// (AgenticRouteTrafficRow.tsx), only while that is on and only where the desktop offers it.
const file = "apps/web/src/components/computers/ComputerDeviceSettings.tsx";

export default [
  {
    id: "desktop-web-import",
    file,
    find: 'import { SettingsGroup, SettingsRow } from "../settings/SettingsRows";\n',
    position: "after",
    text:
      'import type { AgenticRouteTrafficAccess } from "./AgenticRouteTrafficRow";\n' +
      'import { AgenticRouteTrafficRow, agenticRouteTrafficAccess } from "./AgenticRouteTrafficRow";\n',
  },
  {
    id: "desktop-web-type",
    file,
    find: "type ThisComputer = { allowed: boolean; setAllowed: (allowed: boolean) => Promise<unknown> };\n",
    position: "replace",
    text:
      "type ThisComputer = {\n" +
      "  allowed: boolean;\n" +
      "  setAllowed: (allowed: boolean) => Promise<unknown>;\n" +
      "} & AgenticRouteTrafficAccess;\n",
  },
  {
    id: "desktop-web-access",
    file,
    find: "  if (device && paired) return { allowed: paired.allowed, setAllowed: device.setAllowed };\n",
    position: "replace",
    text:
      "  if (device && paired)\n" +
      "    return {\n" +
      "      allowed: paired.allowed,\n" +
      "      setAllowed: device.setAllowed,\n" +
      "      ...agenticRouteTrafficAccess(device, paired),\n" +
      "    };\n",
  },
  {
    id: "desktop-web-open",
    file,
    find: "      ) : thisComputer ? (\n        <SettingsRow\n",
    position: "replace",
    text: "      ) : thisComputer ? (\n        <>\n        <SettingsRow\n",
  },
  {
    id: "desktop-web-row",
    file,
    find: "          }\n        />\n      ) : null}\n      {devices.map((device) => (\n",
    position: "replace",
    text:
      "          }\n" +
      "        />\n" +
      "        <AgenticRouteTrafficRow\n" +
      "          access={thisComputer}\n" +
      "          allowed={thisComputer.allowed}\n" +
      "          pending={pending}\n" +
      "          run={change.run}\n" +
      "        />\n" +
      "        </>\n" +
      "      ) : null}\n" +
      "      {devices.map((device) => (\n",
  },
];
