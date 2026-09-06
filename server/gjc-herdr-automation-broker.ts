import { createHash, randomUUID } from 'node:crypto';

import { herdrManagedChildAutomationControlSchema, type HerdrManagedChildAutomationControl } from '../shared/herdr-managed-child-protocol.js';
import { canonicalManagedInvocation as canonical, verifyManagedBridgeReceipt, type HerdrManagedBridgeAttempt, type HerdrManagedBridgeReceipt } from '../shared/herdr-managed-bridge.js';
import type { HerdrManagedAutomationIdentity, HerdrManagedAutomationOperation, HerdrManagedAutomationProtectedRecord, HerdrManagedCapability } from '../shared/herdr-managed-protocol.js';

import { managedBridgeRequest, GjcAutomationResponseError, type ManagedAutomationDispatcher } from './gjc-automation-tools.js';

type Pending = { sourceOperationId: string; operation: HerdrManagedAutomationOperation; record: HerdrManagedAutomationProtectedRecord; actualDispatch: boolean; resolve(value: unknown): void; reject(error: Error): void; cleanup(): void; transportAbort?: AbortController };
export type ManagedAutomationBrokerOptions = {
  generation: string; provider: string; policyRevision: number; targetContext?: string;
  emit(event: Record<string, unknown>): void;
  flush(): Promise<void>;
};

/** Each source invocation owns one continuation across context replacement and authoritative fencing. */
export class GjcHerdrAutomationBroker {
  private readonly capabilities = new Map<string, HerdrManagedCapability>();
  private turn?: string;
  private readonly pending = new Map<string, Pending>();
  private readonly operationIds = new Set<string>();
  private readonly records = new Map<string, Promise<void>>();
  private readonly cancelled = new WeakSet<Pending>();
  constructor(private readonly options: ManagedAutomationBrokerOptions) {}
  setTurn(turn: string): void { this.turn = turn; }
  status(id: string): 'in_flight' | 'completed' | 'not_found' {
    const p = this.pending.get(id);
    return !p ? 'not_found' : p.operation.phase === 'completed' ? 'completed' : 'in_flight';
  }
  private async publish(p: Pending): Promise<void> {
    const operation = structuredClone(p.operation);
    const record = structuredClone({ ...p.record, sourceOperationId: p.sourceOperationId });
    const persist = (ref: string): Promise<void> => {
      const prior = this.records.get(ref);
      if (prior) return prior;
      const task = (async () => {
        const bytes = Buffer.from(JSON.stringify(record));
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const chunkBytes = 48 * 1024;
        const total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
        for (let index = 0; index < total; index++) {
          this.options.emit({ kind: 'managed.automation-record-chunk', recordId: ref, operationId: operation.identity.operationId, index, total, encoding: 'base64', data: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64'), sha256 });
          await this.options.flush();
        }
      })();
      this.records.set(ref, task);
      return task;
    };
    await persist(operation.argumentsRef);
    if (operation.resultRef) await persist(operation.resultRef);
    if (operation.evidenceRef) await persist(operation.evidenceRef);
    this.options.emit({ kind: 'managed.automation', payload: operation });
    await this.options.flush();
  }
  readonly dispatch: ManagedAutomationDispatcher = ({ toolCallId, index, request, signal }) => {
    if (!this.turn) return Promise.reject(new Error('Managed automation has no active turn.'));
    if (this.pending.size >= 4096) return Promise.reject(new Error('Managed automation operation limit.'));
    const payload = request.payload as Record<string, unknown> | undefined;
    const command = payload?.command as Record<string, unknown> | undefined;
    const url = payload?.url ?? command?.url;
    let targetContext = this.options.targetContext ?? 'unresolved';
    if (typeof url === 'string') {
      try { targetContext = new URL(url).origin; } catch { return Promise.reject(new Error('Invalid automation target URL.')); }
    }
    const identity: HerdrManagedAutomationIdentity = { generation: this.options.generation, provider: this.options.provider, turn: this.turn, toolCallId, index, operationId: randomUUID(), argumentsHash: createHash('sha256').update(canonical(request)).digest('hex'), policyRevision: this.options.policyRevision, targetContext };
    return new Promise((resolve, reject) => {
      const p: Pending = { sourceOperationId: identity.operationId, operation: this.waiting(identity), record: { identity, arguments: structuredClone(request) }, actualDispatch: false, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
      const abort = () => { void this.cancel(p).catch(() => {}); };
      this.pending.set(identity.operationId, p);
      this.operationIds.add(identity.operationId);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void this.publish(p).catch(error => { p.cleanup(); reject(error); });
    });
  };
  private waiting(identity: HerdrManagedAutomationIdentity): HerdrManagedAutomationOperation {
    return { identity, phase: 'waiting_attachment', capabilityGeneration: null, approvalRequestId: null, dispatchCount: 0, argumentsRef: randomUUID(), resultRef: null, evidenceRef: null };
  }
  private async replaceUnsent(p: Pending, targetContext = p.operation.identity.targetContext, policyRevision = p.operation.identity.policyRevision, boundIdentity?: HerdrManagedAutomationIdentity): Promise<void> {
    if (p.actualDispatch) throw new Error('Cannot replace a possibly dispatched operation.');
    const identity = structuredClone(boundIdentity ?? { ...p.operation.identity, operationId: randomUUID(), targetContext, policyRevision });
    if (this.operationIds.has(identity.operationId)) throw new Error('Managed operation identity was already used.');
    this.operationIds.add(identity.operationId);
    const previous = p.operation;
    if (previous.phase !== 'cancelled') {
      previous.phase = 'cancelled';
      await this.publish(p);
    }
    if (p.operation !== previous || this.cancelled.has(p)) return;
    this.pending.delete(previous.identity.operationId);
    p.operation = this.waiting(identity);
    p.record = { identity, arguments: p.record.arguments };
    this.pending.set(identity.operationId, p);
    await this.publish(p);
  }
  private async offer(p: Pending, capability: HerdrManagedCapability): Promise<boolean> {
    if (p.operation.phase !== 'waiting_attachment' || capability.sourceOperationId !== p.sourceOperationId) return false;
    const expected = { ...p.operation.identity, operationId: capability.operationIdentity.operationId, targetContext: capability.targetContext, policyRevision: capability.policyRevision };
    if (canonical(expected) !== canonical(capability.operationIdentity)) return false;
    if (canonical(p.operation.identity) !== canonical(capability.operationIdentity)) {
      await this.replaceUnsent(p, capability.targetContext, capability.policyRevision, capability.operationIdentity);
      if (this.capabilities.get(p.sourceOperationId) !== capability || p.operation.phase !== 'waiting_attachment' || this.cancelled.has(p)) return false;
    }
    p.operation.phase = 'awaiting_reattach_approval';
    p.operation.capabilityGeneration = capability.capabilityGeneration;
    p.operation.approvalRequestId = randomUUID();
    await this.publish(p);
    return true;
  }
  async control(raw: HerdrManagedChildAutomationControl): Promise<boolean> {
    const parsed = herdrManagedChildAutomationControlSchema.safeParse(raw);
    if (!parsed.success) return false;
    const c = parsed.data;
    if (c.type === 'bind-capability' || c.type === 'reconcile') return false;
    if (c.type === 'attach-capability') {
      const cap = c.capability;
      if (cap.generation !== this.options.generation) return false;
      const matches = [...this.pending.values()].filter(p => p.sourceOperationId === cap.sourceOperationId);
      if (matches.length !== 1) return false;
      const p = matches[0];
      if (p.actualDispatch || !['waiting_attachment', 'awaiting_reattach_approval'].includes(p.operation.phase) || this.cancelled.has(p)) return false;
      if (canonical({ ...p.operation.identity, operationId: cap.operationIdentity.operationId, targetContext: cap.targetContext, policyRevision: cap.policyRevision }) !== canonical(cap.operationIdentity)) return false;
      if (cap.operationIdentity.operationId !== p.operation.identity.operationId && this.operationIds.has(cap.operationIdentity.operationId)) return false;
      if (cap.operationIdentity.operationId === p.operation.identity.operationId && canonical(cap.operationIdentity) !== canonical(p.operation.identity)) return false;
      const prior = this.capabilities.get(p.sourceOperationId);
      if (prior) await this.detach(prior);
      this.capabilities.set(p.sourceOperationId, cap);
      const offered = await this.offer(p, cap);
      if (!offered && this.capabilities.get(p.sourceOperationId) === cap) this.capabilities.delete(p.sourceOperationId);
      return offered;
    }
    if (c.type === 'detach-capability') {
      const cap = [...this.capabilities.values()].find(cap => cap.generation === c.generation && cap.capabilityGeneration === c.capabilityGeneration && cap.ownerConnectionId === c.ownerConnectionId);
      if (!cap) return false;
      await this.detach(cap); return true;
    }
    const p = this.pending.get(c.identity.operationId);
    if (!p || canonical(p.operation.identity) !== canonical(c.identity)) return false;
    if (c.type === 'reconcile-verified') {
      if (p.operation.phase !== 'outcome_unknown' || !p.record.attempt) return false;
      let receipt: HerdrManagedBridgeReceipt;
      try { receipt = verifyManagedBridgeReceipt(c.receipt, p.record.attempt); } catch { return false; }
      return this.acceptReceipt(p, p.operation, p.record.attempt, receipt);
    }
    const cap = this.capabilities.get(p.sourceOperationId);
    if (!cap || p.operation.phase !== 'awaiting_reattach_approval' || p.operation.approvalRequestId !== c.approvalRequestId || cap.capabilityGeneration !== c.capabilityGeneration || cap.targetContext !== c.identity.targetContext || cap.policyRevision !== c.identity.policyRevision) return false;
    const operation = p.operation;
    const attempt: HerdrManagedBridgeAttempt = { identity: structuredClone(operation.identity), originalCapabilityGeneration: cap.capabilityGeneration, requestId: randomUUID(), bridgeInstanceId: cap.bridgeInstanceId, sourceOperationId: p.sourceOperationId, targetBinding: structuredClone(cap.targetBinding) };
    p.record.attempt = attempt;
    operation.argumentsRef = randomUUID();
    operation.phase = 'dispatching'; operation.dispatchCount = 1;
    await this.publish(p);
    if (this.capabilities.get(p.sourceOperationId) !== cap || p.operation !== operation || operation.phase !== 'dispatching') return false;
    p.transportAbort = new AbortController(); p.actualDispatch = true;
    void managedBridgeRequest({ socketPath: cap.transportLocator, token: cap.transportToken }, { type: 'managed-dispatch', attempt, invocation: p.record.arguments }, p.transportAbort.signal).then(async value => {
      const receipt = verifyManagedBridgeReceipt(value, attempt);
      await this.acceptReceipt(p, operation, attempt, receipt);
    }).catch(async () => {
      if (p.operation !== operation || ['cancelled', 'completed', 'outcome_unknown'].includes(operation.phase)) return;
      operation.phase = 'outcome_unknown'; await this.publish(p);
    }).catch(() => {});
    return true;
  }
  private async acceptReceipt(p: Pending, operation: HerdrManagedAutomationOperation, attempt: HerdrManagedBridgeAttempt, receipt: HerdrManagedBridgeReceipt): Promise<boolean> {
    if (p.operation !== operation || ['cancelled', 'completed'].includes(operation.phase) || canonical(p.record.attempt) !== canonical(attempt)) return false;
    if (receipt.status === 'unknown') { operation.phase = 'outcome_unknown'; await this.publish(p); return true; }
    p.record.evidence = { verifier: 'managed-bridge-ledger-v1', observedAt: new Date().toISOString(), content: receipt };
    p.record.receipt = receipt;
    operation.evidenceRef = randomUUID();
    if (receipt.status === 'not_dispatched') {
      operation.phase = 'cancelled';
      p.transportAbort?.abort();
      await this.publish(p);
      if (p.operation !== operation || this.cancelled.has(p)) return false;
      p.actualDispatch = false;
      this.capabilities.delete(p.sourceOperationId);
      await this.replaceUnsent(p);
      return true;
    }
    p.record.result = receipt.response.ok ? receipt.response.result : { error: receipt.response.error };
    operation.resultRef = randomUUID(); operation.phase = 'completed';
    this.capabilities.delete(p.sourceOperationId);
    try { await this.publish(p); }
    catch {
      p.cleanup();
      p.reject(new Error('Managed completion persistence failed.'));
      // Keep the exact terminal receipt and never redispatch an already
      // completed operation just because its local projection failed.
      return false;
    }
    p.cleanup();
    if (receipt.response.ok) p.resolve(receipt.response.result);
    else p.reject(new GjcAutomationResponseError(receipt.response.error));
    return true;
  }
  private async detach(cap: HerdrManagedCapability): Promise<void> {
    if (this.capabilities.get(cap.sourceOperationId) !== cap) return;
    this.capabilities.delete(cap.sourceOperationId);
    for (const p of this.pending.values()) {
      if (p.sourceOperationId !== cap.sourceOperationId || !['dispatching', 'awaiting_reattach_approval'].includes(p.operation.phase)) continue;
      if (p.operation.phase === 'dispatching' && !p.actualDispatch) { await this.replaceUnsent(p); continue; }
      p.operation.phase = p.actualDispatch ? 'outcome_unknown' : 'waiting_attachment';
      p.operation.approvalRequestId = null; await this.publish(p);
    }
  }
  private async cancel(p: Pending): Promise<void> {
    if (this.cancelled.has(p) || p.operation.phase === 'completed') return;
    this.cancelled.add(p); p.transportAbort?.abort(); p.cleanup();
    if (p.operation.phase === 'cancelled') { p.reject(new Error('Managed automation aborted.')); return; }
    p.operation.phase = 'cancelled';
    try { await this.publish(p); } finally { p.reject(new Error('Managed automation aborted.')); }
  }
  async abort(): Promise<void> { await Promise.all([...this.pending.values()].map(p => this.cancel(p))); }
}
