// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
import { Trans, useLingui } from "@lingui/react/macro";
import type { RakazoDesktop, RakazoDesktopDevice } from "@rakazo/contracts";
import { Label, Switch } from "@rakazo/ui-web";
import { useId } from "react";
import { SettingsRow } from "../settings/SettingsRows";

export interface AgenticRouteTrafficAccess {
  routeTraffic?: boolean;
  setRouteTraffic?: (enabled: boolean) => Promise<unknown>;
}

/** Only when the desktop offers it: a paired remote server on a platform that can sandbox it. */
export function agenticRouteTrafficAccess(
  device: NonNullable<RakazoDesktop["device"]>,
  paired: RakazoDesktopDevice,
): AgenticRouteTrafficAccess {
  if (typeof paired.routeTraffic !== "boolean" || !device.setRouteTraffic) return {};
  return { routeTraffic: paired.routeTraffic, setRouteTraffic: device.setRouteTraffic };
}

export function AgenticRouteTrafficRow({
  access,
  allowed,
  pending,
  run,
}: {
  access: AgenticRouteTrafficAccess;
  allowed: boolean;
  pending: boolean;
  run: (input: { action: () => Promise<unknown>; failure: string }) => void;
}): React.ReactNode {
  const { t } = useLingui();
  const switchId = useId();
  const { routeTraffic, setRouteTraffic } = access;
  if (!allowed || routeTraffic === undefined || !setRouteTraffic) return null;
  return (
    <SettingsRow
      label={
        <Label htmlFor={switchId} className="text-body font-normal text-foreground">
          <Trans>Route traffic through this computer</Trans>
        </Label>
      }
      control={
        <Switch
          id={switchId}
          data-testid="route-traffic-toggle"
          checked={routeTraffic}
          disabled={pending}
          onCheckedChange={(enabled) =>
            run({ action: () => setRouteTraffic(enabled), failure: t`Could not change` })
          }
        />
      }
    />
  );
}
