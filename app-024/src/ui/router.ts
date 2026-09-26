// 手写 hash 路由（#/、#/riddle/:id、#/print、#/onsite、#/library、#/settings）
import { useEffect, useState, useSyncExternalStore } from 'react';
import { store, type AppState } from '../lib/store';

export type Route =
  | { name: 'list' }
  | { name: 'edit'; id: string }
  | { name: 'print' }
  | { name: 'print-schedule' }
  | { name: 'onsite' }
  | { name: 'schedule' }
  | { name: 'session'; id: string }
  | { name: 'library' }
  | { name: 'settings' };

export function parseHash(hash: string): Route {
  const path = (hash.replace(/^#/, '') || '/').split('?')[0];
  const m = path.match(/^\/riddle\/(.+)$/);
  if (m) return { name: 'edit', id: decodeURIComponent(m[1]) };
  const sm = path.match(/^\/session\/(.+)$/);
  if (sm) return { name: 'session', id: decodeURIComponent(sm[1]) };
  switch (path) {
    case '/print': return { name: 'print' };
    case '/print-schedule': return { name: 'print-schedule' };
    case '/onsite': return { name: 'onsite' };
    case '/schedule': return { name: 'schedule' };
    case '/library': return { name: 'library' };
    case '/settings': return { name: 'settings' };
    default: return { name: 'list' };
  }
}

export function navigate(to: string): void {
  if (location.hash === to) return;
  location.hash = to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
