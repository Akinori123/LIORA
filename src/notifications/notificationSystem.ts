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

    if (durationMs > 0) {
      setTimeout(() => {
        this.dismiss(id);
      }, durationMs);
    }

    return id;
  }

  public dismiss(id: string): void {
    this.activeNotifications = this.activeNotifications.filter(n => n.id !== id);
    this.broadcast();
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
