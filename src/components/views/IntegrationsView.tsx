/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { 
  Key, 
  ShieldCheck, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Activity, 
  Webhook, 
  Plus, 
  RefreshCw, 
  Lock, 
  Globe, 
  Sliders, 
  Cpu, 
  CreditCard, 
  Database, 
  Cloud,
  X,
  Send,
  Eye,
  EyeOff
} from 'lucide-react';
import { IntegrationCategory, IntegrationProviderId, IntegrationServiceConfig } from '../../types/integrations';
// CORREÇÃO (Etapa A — modal guiado IMAP/SMTP): formulário com campos separados
// (Servidor IMAP, Porta, SMTP, Porta, E-mail, Senha) em vez de "cole o token" opaco.
import { EmailSetupModal } from '../integrations/EmailSetupModal';

export const IntegrationsView: React.FC = () => {
  const { 
    services, 
    webhookLogs, 
    keychainFallbackActive,
    connectService, 
    disconnectService, 
    testServiceConnection, 
    toggleServiceScope, 
    simulateIncomingWebhook 
  } = useLioraStore();

  const [selectedCategory, setSelectedCategory] = useState<IntegrationCategory | 'all'>('all');
  const [testingServiceId, setTestingServiceId] = useState<string | null>(null);
  
  // Modal de Conexão
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);
  const [activeService, setActiveService] = useState<IntegrationServiceConfig | null>(null);
  const [inputKey, setInputKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [customEndpoint, setCustomEndpoint] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);

  // Simulador de Webhooks
  const [simProvider, setSimProvider] = useState<IntegrationProviderId>('mercadopago');
  const [simEventType, setSimEventType] = useState('payment.approved');
  const [simPayloadJson, setSimPayloadJson] = useState('{\n  "payment_id": "mp_9823412",\n  "status": "approved",\n  "amount": 150.00,\n  "currency": "BRL"\n}');
  const [isSimulating, setIsSimulating] = useState(false);
  const [webhookFeedback, setWebhookFeedback] = useState<string | null>(null);

  // CORREÇÃO (Etapa A): modal guiado para serviços de E-mail (IMAP/SMTP)
  const [isEmailSetupOpen, setIsEmailSetupOpen] = useState(false);

  const filteredServices = selectedCategory === 'all' 
    ? services 
    : services.filter(s => s.category === selectedCategory);

  const handleOpenConnect = (service: IntegrationServiceConfig) => {
    setActiveService(service);
    setInputKey('');
    setShowKey(false);
    setCustomEndpoint(service.endpointUrl || '');
    setConnectError(null);

    // CORREÇÃO (Etapa A): serviços de E-mail abrem o modal GUIADO com campos
    // separados (IMAP/SMTP/E-mail/Senha) em vez do campo genérico "cole o token".
    if (service.provider === 'email' || service.id === 'svc-email-imap') {
      setIsEmailSetupOpen(true);
      return;
    }

    setIsConnectModalOpen(true);
  };

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeService) return;
    if (!inputKey.trim()) {
      setConnectError('Insira uma chave ou token de autenticação válido.');
      return;
    }

    try {
      const success = await connectService(activeService.id, inputKey.trim(), {
        endpointUrl: customEndpoint.trim() || undefined
      });

      if (success) {
        setIsConnectModalOpen(false);
      } else {
        setConnectError('Falha ao autenticar com o provedor.');
      }
    } catch (err: any) {
      setConnectError(err?.message || 'Erro inesperado.');
    }
  };

  const handleTestPing = async (serviceId: string) => {
    setTestingServiceId(serviceId);
    try {
      await testServiceConnection(serviceId);
    } finally {
      setTimeout(() => {
        setTestingServiceId(null);
      }, 400);
    }
  };

  const handleSimulateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSimulating(true);
    setWebhookFeedback(null);

    let parsedPayload = {};
    try {
      parsedPayload = JSON.parse(simPayloadJson);
    } catch {
      setWebhookFeedback('JSON inválido no corpo do Webhook.');
      setIsSimulating(false);
      return;
    }

    try {
      const res = await simulateIncomingWebhook(simProvider, simEventType, parsedPayload);
      setWebhookFeedback(`Webhook ${res.id} recebido com sucesso e despachado ao EventBus!`);
    } catch {
      setWebhookFeedback('Erro ao despachar webhook.');
    } finally {
      setIsSimulating(false);
      setTimeout(() => setWebhookFeedback(null), 5000);
    }
  };

  const getCategoryIcon = (category: IntegrationCategory) => {
    switch (category) {
      case 'ai': return <Cpu className="w-4 h-4 text-[var(--accent-primary)]" />;
      case 'cloud': return <Cloud className="w-4 h-4 text-blue-400" />;
      case 'finance': return <CreditCard className="w-4 h-4 text-emerald-400" />;
      case 'database': return <Database className="w-4 h-4 text-amber-400" />;
      default: return <Globe className="w-4 h-4 text-purple-400" />;
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-8 space-y-8 max-w-6xl mx-auto w-full">
      {/* Keychain Fallback Notice */}
      {keychainFallbackActive && (
        <div className="flex items-center justify-between p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs font-mono text-amber-300">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              Aviso do Cofre Nativo: Acesso negado pelo SO ou cancelado pelo usuário. Fallback ativado em memória cifrada segura.
            </span>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-display font-bold text-white">Central de Conexões & Cofre de Chaves</h2>
            <span className="px-2.5 py-0.5 rounded text-[10px] font-mono uppercase bg-[#141414] border border-[#222222] text-[#A8A8A8]">
              Blindagem de Produção • Vault Ativo
            </span>
          </div>
          <p className="text-sm text-[#A8A8A8] mt-1">
            Gestão protegida de chaves de API, isolamento de escopos, anti-flapping MCP, anti-replay e monitoramento de latência.
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-[#141414] border border-[#222222] rounded-lg text-xs font-mono text-[#10b981]">
          <ShieldCheck className="w-4 h-4" />
          <span>Zero-Leakage Vault Ativo</span>
        </div>
      </div>

      {/* Category Tabs Filter */}
      <div className="flex items-center gap-2 border-b border-[#222222] pb-3">
        {(['all', 'ai', 'cloud', 'database', 'finance'] as const).map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              selectedCategory === cat 
                ? 'bg-[#1F1F1F] text-white border border-[#333333]' 
                : 'text-[#888888] hover:text-[#CCCCCC]'
            }`}
          >
            {cat === 'all' ? 'Todos os Serviços' :
             cat === 'ai' ? 'Modelos & IA' :
             cat === 'cloud' ? 'Cloud & CI/CD' :
             cat === 'database' ? 'Banco de Dados' : 'Finanças & Pagamentos'}
          </button>
        ))}
      </div>

      {/* Services Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {filteredServices.map((service) => {
          const isTesting = testingServiceId === service.id;
          const isConnected = service.status === 'CONNECTED';
          const isDegraded = service.status === 'DEGRADED';
          const isRateLimited = service.status === 'RATE_LIMITED';

          return (
            <div 
              key={service.id}
              className="bg-[#111111] border border-[#222222] hover:border-[#333333] transition-colors rounded-xl p-6 flex flex-col justify-between space-y-5"
            >
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-[#171717] border border-[#2A2A2A] rounded-lg">
                      {getCategoryIcon(service.category)}
                    </div>
                    <div>
                      <h3 className="font-semibold text-white text-base">{service.name}</h3>
                      <span className="text-[11px] font-mono uppercase text-[#888888]">{service.provider}</span>
                    </div>
                  </div>

                  <span className={`px-2.5 py-1 rounded-full text-xs font-mono flex items-center gap-1.5 border ${
                    isConnected 
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : isDegraded
                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                      : isRateLimited
                      ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30'
                      : 'bg-[#171717] text-[#888888] border-[#2A2A2A]'
                  }`}>
                    {isConnected ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                     isDegraded ? <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> :
                     isRateLimited ? <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" /> :
                     <XCircle className="w-3.5 h-3.5" />}
                    {service.status}
                  </span>
                </div>

                <p className="text-xs text-[#A8A8A8] mt-3 leading-relaxed">
                  {service.description}
                </p>

                {/* Key and Fingerprint Details */}
                <div className="mt-4 bg-[#141414] border border-[#1E1E1E] rounded-lg p-3 space-y-1.5 text-xs font-mono">
                  <div className="flex items-center justify-between text-[#888888]">
                    <span>Credencial no Cofre:</span>
                    <span className="text-white font-medium">
                      {service.maskedKey || 'Não configurada'}
                    </span>
                  </div>
                  {service.keyFingerprint && (
                    <div className="flex items-center justify-between text-[#888888]">
                      <span>Hash Fingerprint:</span>
                      <span className="text-[#A8A8A8]">SHA: {service.keyFingerprint}...</span>
                    </div>
                  )}
                  {isConnected && service.latencyMs !== undefined && (
                    <div className="flex items-center justify-between text-[#888888]">
                      <span>Latência Aferida:</span>
                      <span className="text-emerald-400 font-bold">{service.latencyMs}ms</span>
                    </div>
                  )}
                </div>

                {/* Scopes Section */}
                <div className="mt-4">
                  <span className="text-[11px] font-semibold uppercase text-[#666666] tracking-wider block mb-2">
                    Escopos de Acesso Autorizados
                  </span>
                  <div className="space-y-1.5">
                    {service.scopes.map((scope) => (
                      <label 
                        key={scope.id} 
                        className="flex items-center justify-between p-2 bg-[#141414] hover:bg-[#181818] border border-[#1E1E1E] rounded text-xs cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={scope.granted}
                            onChange={() => toggleServiceScope(service.id, scope.id)}
                            className="rounded border-[#333333] text-[var(--accent-primary)] focus:ring-0 bg-[#171717]"
                          />
                          <span className="text-white font-mono text-[11px]">{scope.name}</span>
                        </div>
                        {scope.required && (
                          <span className="text-[10px] font-mono text-[#888888]">(Requerido)</span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Features chips */}
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {service.featuresSupported.map((feat, idx) => (
                    <span key={idx} className="px-2 py-0.5 bg-[#171717] border border-[#262626] rounded text-[10px] font-mono text-[#A8A8A8]">
                      {feat}
                    </span>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-3 border-t border-[#1E1E1E]">
                <div className="flex items-center gap-2">
                  {isConnected && (
                    <button
                      onClick={() => handleTestPing(service.id)}
                      disabled={isTesting}
                      className="px-3 py-1.5 bg-[var(--accent-bg)] border border-[var(--accent-border)] text-[var(--accent-primary)] rounded-lg text-xs font-mono flex items-center gap-1.5 transition-colors disabled:opacity-50 hover:opacity-90"
                      title="Testar conexão e latência"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
                      <span>{isTesting ? 'Testando...' : 'Testar Ping'}</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {isConnected ? (
                    <>
                      <button
                        onClick={() => handleOpenConnect(service)}
                        className="px-3 py-1.5 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all shadow-md shadow-[var(--accent-glow)] hover:opacity-90"
                        style={{ backgroundColor: 'var(--accent-primary)' }}
                        title="Alterar chave ou endpoint"
                      >
                        <Key className="w-3.5 h-3.5" />
                        <span>Configurar</span>
                      </button>
                      <button
                        onClick={() => disconnectService(service.id)}
                        className="px-3 py-1.5 bg-[#171717] hover:bg-red-500/10 border border-[#2E2E2E] hover:border-red-500/30 text-xs font-mono text-[#888888] hover:text-red-400 rounded-lg transition-colors"
                      >
                        Desconectar
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleOpenConnect(service)}
                      className="px-4 py-1.5 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all shadow-md shadow-[var(--accent-glow)] hover:opacity-90"
                      style={{ backgroundColor: 'var(--accent-primary)' }}
                    >
                      <Key className="w-3.5 h-3.5" />
                      <span>Conectar</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Webhooks Ingestion & Simulator Section */}
      <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-6">
        <div className="flex items-center justify-between border-b border-[#222222] pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-[#171717] border border-[#2E2E2E] rounded-lg text-[var(--accent-primary)]">
              <Webhook className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-white text-base">Receptor & Simulador de Webhooks Externos</h3>
              <p className="text-xs text-[#888888]">
                Ingestão de eventos HTTP (IPN, Deploys, Commits) com higienização de segredos e publicação no EventBus.
              </p>
            </div>
          </div>
          <span className="px-2.5 py-1 bg-purple-500/10 border border-purple-500/20 text-purple-400 font-mono text-xs rounded">
            Endpoint: /api/webhooks/:provider
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Form Simulador */}
          <form onSubmit={handleSimulateWebhook} className="space-y-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[#A8A8A8]">
              Disparar Evento Webhook Simulado
            </h4>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-mono text-[#888888] mb-1">Provedor</label>
                <select
                  value={simProvider}
                  onChange={(e) => {
                    const prov = e.target.value as IntegrationProviderId;
                    setSimProvider(prov);
                    if (prov === 'mercadopago') {
                      setSimEventType('payment.approved');
                      setSimPayloadJson('{\n  "payment_id": "mp_9823412",\n  "status": "approved",\n  "amount": 150.00,\n  "currency": "BRL"\n}');
                    } else if (prov === 'github') {
                      setSimEventType('push');
                      setSimPayloadJson('{\n  "ref": "refs/heads/main",\n  "repository": "liora-core",\n  "commits": 1\n}');
                    } else if (prov === 'vercel') {
                      setSimEventType('deployment.succeeded');
                      setSimPayloadJson('{\n  "deploymentId": "dpl_abc123",\n  "url": "https://liora.app",\n  "state": "READY"\n}');
                    } else {
                      setSimEventType('custom.event');
                      setSimPayloadJson('{\n  "action": "trigger",\n  "value": true\n}');
                    }
                  }}
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)]"
                >
                  <option value="mercadopago">Mercado Pago (IPN)</option>
                  <option value="github">GitHub Webhook</option>
                  <option value="vercel">Vercel Deployments</option>
                  <option value="supabase">Supabase CDC</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-mono text-[#888888] mb-1">Tipo de Evento</label>
                <input
                  type="text"
                  value={simEventType}
                  onChange={(e) => setSimEventType(e.target.value)}
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)]"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-mono text-[#888888] mb-1">Payload JSON (Simulado)</label>
              <textarea
                rows={4}
                value={simPayloadJson}
                onChange={(e) => setSimPayloadJson(e.target.value)}
                className="w-full bg-[#171717] border border-[#333333] rounded-lg p-2.5 text-xs font-mono text-[#CCCCCC] focus:outline-none focus:border-[var(--accent-primary)]"
              />
            </div>

            <button
              type="submit"
              disabled={isSimulating}
              className="px-4 py-2 bg-[var(--accent-primary)] hover:opacity-90 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-all shadow-md shadow-[var(--accent-glow)] disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isSimulating ? 'Despachando...' : 'Despachar Webhook'}</span>
            </button>

            {webhookFeedback && (
              <p className="text-xs font-mono text-emerald-400 bg-emerald-500/10 p-2.5 rounded-lg border border-emerald-500/20">
                {webhookFeedback}
              </p>
            )}
          </form>

          {/* Lista de Webhooks Ingeridos */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[#A8A8A8]">
              Últimos Eventos Ingeridos ({webhookLogs.length})
            </h4>

            {webhookLogs.length === 0 ? (
              <div className="bg-[#141414] border border-[#222222] rounded-xl p-6 text-center text-xs text-[#888888]">
                Nenhum webhook recebido ainda. Use o formulário ao lado para simular.
              </div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {webhookLogs.map((wh) => (
                  <div 
                    key={wh.id}
                    className="bg-[#141414] border border-[#222222] rounded-lg p-3 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 bg-[#1F1F1F] text-[var(--accent-primary)] font-mono text-[10px] uppercase rounded">
                          {wh.provider}
                        </span>
                        <span className="font-semibold text-white">{wh.eventType}</span>
                      </div>
                      <span className="text-[10px] font-mono text-[#888888]">
                        {new Date(wh.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <pre className="text-[11px] font-mono text-[#A8A8A8] bg-[#0A0A0A] p-2 rounded overflow-x-auto">
                      {JSON.stringify(wh.rawPayloadSafe, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal Conectar Credencial */}
      {isConnectModalOpen && activeService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#111111] border border-[#333333] rounded-2xl max-w-lg w-full p-6 space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#222222] pb-4">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-[var(--accent-primary)]" />
                <h3 className="font-bold text-lg text-white">Conectar {activeService.name}</h3>
              </div>
              <button 
                onClick={() => setIsConnectModalOpen(false)}
                className="text-[#888888] hover:text-white p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleConnectSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                  Chave de API / Token Secreto
                </label>
                <div className="relative">
                  <input 
                    type={showKey ? 'text' : 'password'}
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    placeholder="Cole aqui o token de autenticação..."
                    className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)] pr-10 font-mono"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-2.5 text-[#888888] hover:text-white"
                  >
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-[#777777] mt-1.5">
                  A chave é processada exclusivamente no cofre local, com geração de fingerprint SHA-256 e mascaramento zero-leakage.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                  URL do Endpoint / API (Opcional)
                </label>
                <input 
                  type="text"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder={activeService.endpointUrl || 'https://api.exemplo.com'}
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)]"
                />
              </div>

              {connectError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs font-mono text-red-400">
                  {connectError}
                </div>
              )}

              <div className="pt-4 flex items-center justify-end gap-3 border-t border-[#222222]">
                <button
                  type="button"
                  onClick={() => setIsConnectModalOpen(false)}
                  className="px-4 py-2 bg-[#171717] hover:bg-[#222222] text-[#888888] hover:text-white text-xs font-semibold rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-[var(--accent-primary)] hover:opacity-90 text-white text-xs font-semibold rounded-lg shadow-md shadow-[var(--accent-glow)] transition-all"
                >
                  Validar e Armazenar no Cofre
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CORREÇÃO (Etapa A): Modal guiado de configuração IMAP/SMTP — grava no cofre
          via connectService (status muda para CONNECTED em tempo real) */}
      {activeService && (
        <EmailSetupModal
          isOpen={isEmailSetupOpen}
          onClose={() => setIsEmailSetupOpen(false)}
          serviceId={activeService.id}
          serviceName={activeService.name}
          onConnect={async (rawKey) => connectService(activeService.id, rawKey)}
        />
      )}
    </div>
  );
};
