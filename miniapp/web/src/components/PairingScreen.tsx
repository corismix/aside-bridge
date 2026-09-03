import { FormEvent, useState } from 'react';
import { AsideSymbol, Spinner } from './Icons';
import { api } from '../api';

export function PairingScreen({
  onPaired,
}: {
  onPaired: (name?: string) => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.pair(code);
      onPaired(result.user.firstName);
    } catch (err) {
      setError(
        (err as Error).message.includes('invalid_or_expired_code')
          ? 'That code is invalid or has expired.'
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="boot pairing-screen">
      <span className="pairing-mark"><AsideSymbol size={28} /></span>
      <div>
        <p className="boot-title">Connect Aside</p>
        <p className="boot-reason">
          Run <code>bridgemon miniapp pair</code> on the Mac, then enter the
          one-time code here.
        </p>
      </div>
      <form className="pairing-form" onSubmit={submit}>
        <input
          className="pairing-input"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          maxLength={20}
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="20-character code"
          aria-label="Pairing code"
          autoFocus
        />
        <button className="pairing-button" type="submit" disabled={busy || !code.trim()}>
          {busy ? <Spinner size={14} /> : 'Connect'}
        </button>
      </form>
      {error ? <p className="pairing-error">{error}</p> : null}
    </div>
  );
}
