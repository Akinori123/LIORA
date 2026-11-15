/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface SystemNotification {
  id: string;
  title: string;
  message: string;
  level: NotificationLevel;
  timestamp: string;
  durationMs?: number;
}

class NotificationSystem {
  private listeners = new Set<(notifications: SystemNotification[]) => void>();
  private activeNotifications: SystemNotification[] = [];
  private autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

  public notify(title: string, message: string, level: NotificationLevel = 'info', durationMs = 4000): string {
    const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const item: SystemNotification = {
      id,
      title,
      message,
      level,
      timestamp: new Date().toLocaleTimeString(),
      durationMs
    };

    this.activeNotifications = [item, ...this.activeNotifications.slice(0, 9)];
    this.broadcast();

    // Enviar notificação nativa para o sistema operacional se permitido
    this.dispatchNativeNotification(title, message);

    if (durationMs > 0) {
      const timer = setTimeout(() => {
        this.autoDismissTimers.delete(id);
        this.dismiss(id);
      }, durationMs);
      this.autoDismissTimers.set(id, timer);
    }

    return id;
  }

  private dispatchNativeNotification(title: string, message: string): void {
    if (typeof window === 'undefined') return;

    try {
      // 1. Tentar disparar via Tauri IPC se estiver no container Desktop nativo
      const tauri = (window as any).__TAURI__;
      if (tauri?.notification?.sendNotification) {
        tauri.notification.sendNotification({ title, body: message });
        return;
      }
      if (tauri?.invoke) {
        tauri.invoke('plugin:notification|notify', { options: { title, body: message } }).catch(() => {});
      }

      // 2. Disparar via Web Notifications API padrão (Windows/Linux/macOS)
      if ('Notification' in window && Notification.permission === 'granted') {
        const notif = new Notification(title, {
          body: message,
          icon: '/favicon.ico',
          silent: false
        });
        notif.onclick = () => {
          try {
            window.focus();
          } catch {}
        };
      }
    } catch (err) {
      // Falha silenciosa para não travar a aplicação
    }
  }

  public dismiss(id: string): void {
    const timer = this.autoDismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.autoDismissTimers.delete(id);
    }
    const prevLen = this.activeNotifications.length;
    this.activeNotifications = this.activeNotifications.filter(n => n.id !== id);
    if (this.activeNotifications.length !== prevLen) {
      this.broadcast();
    }
  }

  public getNotifications(): SystemNotification[] {
    return [...this.activeNotifications];
  }

  public subscribe(cb: (items: SystemNotification[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.getNotifications());
    return () => this.listeners.delete(cb);
  }

  private broadcast(): void {
    this.listeners.forEach(cb => cb(this.getNotifications()));
  }
}

export const notificationSystem = new NotificationSystem();
export default notificationSystem;
