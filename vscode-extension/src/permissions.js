'use strict';
/**
 * Permission broker for destructive tool actions.
 *
 * A modal dialog per write destroys the agent experience: multi-step work stalls
 * on a popup every few seconds. This broker instead keeps a per-session grant
 * table and hands the decision to whichever surface is driving the run:
 *
 *   - request(kind, detail) resolves true/false
 *   - "always" grants are remembered for the session (kind: 'write' | 'exec')
 *   - a surface that cannot ask (headless use) can pre-grant everything
 */

const KIND_WRITE = 'write';
const KIND_EXEC = 'exec';

class PermissionBroker {
  /**
   * @param options {
   *   onRequest?: (kind, detail) => Promise<'once'|'always'|'deny'>,
   *   grants?:    { write?: boolean, exec?: boolean },   initial session grants
   * }
   */
  constructor(options) {
    const opts = options || {};
    this.onRequest = typeof opts.onRequest === 'function' ? opts.onRequest : null;
    this.grants = {
      [KIND_WRITE]: !!(opts.grants && opts.grants.write),
      [KIND_EXEC]: !!(opts.grants && opts.grants.exec),
    };
  }

  /** Pre-grant a kind for the rest of the session. */
  grant(kind) { this.grants[kind] = true; }
  revoke(kind) { this.grants[kind] = false; }
  isGranted(kind) { return !!this.grants[kind]; }

  /**
   * Ask for permission to perform `kind`.
   * Returns true when allowed. A "always" answer upgrades the session grant.
   */
  async request(kind, detail) {
    if (this.grants[kind]) return true;
    if (!this.onRequest) return false;
    let answer;
    try {
      answer = await this.onRequest(kind, detail);
    } catch {
      return false;
    }
    if (answer === 'always') {
      this.grants[kind] = true;
      return true;
    }
    return answer === 'once' || answer === 'allow' || answer === true;
  }
}

module.exports = { PermissionBroker, KIND_WRITE, KIND_EXEC };
