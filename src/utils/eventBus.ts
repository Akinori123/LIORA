/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { IEventBus, EventBusListener } from '../types/automations';

/**
 * Barramento de Eventos Local Pub/Sub desacoplado, assíncrono e tipado.
 * Suporta múltiplos ouvintes por tópico com isolamento de falhas.
 */
export class EventBus implements IEventBus {
  private listeners: Map<string, Set<EventBusListener>> = new Map();

  /**
   * Registra um ouvinte para um determinado evento.
   * Retorna uma função para cancelamento seguro da inscrição.
   */
  public subscribe<T = any>(event: string, listener: EventBusListener<T>): () => void {
    if (!event || typeof event !== 'string') {
      throw new Error('Identificador de evento inválido.');
    }
    if (typeof listener !== 'function') {
      throw new Error('Ouvinte deve ser uma função.');
    }

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const set = this.listeners.get(event)!;
    set.add(listener);

    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  /**
   * Publica um evento para todos os ouvintes inscritos.
   * Garante isolamento de falhas: o erro de um ouvinte não impede os demais de executarem.
   */
  public async publish<T = any>(event: string, payload?: T): Promise<void> {
    if (!event || typeof event !== 'string') {
      return;
    }

    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return;
    }

    // Cria cópia defensiva para evitar mutação do conjunto durante o loop
    const listenersArray = Array.from(set);

    for (const listener of listenersArray) {
      try {
        await Promise.resolve(listener(payload as T));
      } catch (err) {
        // Falha isolada do ouvinte capturada sem interromper os outros
        console.error(`[EventBus] Erro ao executar ouvinte para o evento '${event}':`, err);
      }
    }
  }

  /**
   * Retorna a quantidade de ouvintes registrados para um tópico
   */
  public listenerCount(event: string): number {
    return this.listeners.get(event)?.size || 0;
  }

  /**
   * Remove todas as inscrições ativas no barramento
   */
  public clear(): void {
    this.listeners.clear();
  }
}

// Instância singleton padrão do Barramento de Eventos
export const eventBus = new EventBus();
