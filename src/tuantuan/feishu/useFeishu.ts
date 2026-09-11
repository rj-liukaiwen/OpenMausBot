import { useEffect, useRef, useState } from "react";
import type { FeishuAction, FeishuBridge, FeishuSnapshot } from "./model";
import { createFeishuSession } from "./session";

export function localFeishuBridge(host?: {
  platform: string; remoteClient?: { active: boolean }; feishu?: FeishuBridge;
}) {
  return host && ["win32", "darwin"].includes(host.platform) && !host.remoteClient?.active
    ? host.feishu : undefined;
}

export function useFeishu(enabled: boolean) {
  const bridge = localFeishuBridge(typeof window !== "undefined" ? window.ogb : undefined);
  const [snapshot, setSnapshot] = useState<FeishuSnapshot>({ state: null, busy: null, error: null });
  const session = useRef<ReturnType<typeof createFeishuSession> | null>(null);
  useEffect(() => {
    if (!enabled || !bridge) return;
    setSnapshot({ state: null, busy: null, error: null });
    const current = createFeishuSession(bridge, setSnapshot);
    session.current = current;
    return () => {
      current.dispose();
      session.current = null;
    };
  }, [bridge, enabled]);
  return {
    ...snapshot,
    available: Boolean(bridge),
    invoke: (action: FeishuAction, input?: { botId?: string }) => session.current?.invoke(action, input),
  };
}
