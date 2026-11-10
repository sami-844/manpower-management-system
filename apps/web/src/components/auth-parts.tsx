/**
 * Pieces shared by S-01 Sign in and S-46 My account: the 6-digit code box, the authenticator QR
 * code, the error alert and the plain-words message for each sign-in error code.
 */
import { useMemo, type ReactNode, type Ref } from "react";
import { encode } from "uqr";
import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";

export const OFFLINE = "We couldn't reach the server. Check your connection and try again.";

export function ErrorAlert({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Alert variant="destructive" id={id}>
      <AlertCircleIcon aria-hidden />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);

export function CodeInput({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  autoFocus = true,
  inputRef,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <Input
      ref={inputRef}
      id={id}
      name="otp"
      value={value}
      onChange={(e) => onChange(digits(e.target.value))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      autoFocus={autoFocus}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      className="font-mono text-lg tracking-[0.4em] tabular-nums"
    />
  );
}

/** QR code drawn from `uqr`'s module grid. Always dark on light, whatever the theme: phone scanners need that contrast. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const { data } = encode(text, { border: 4 });
    return { size: data.length, d: data.flatMap((row, y) => row.flatMap((on, x) => (on ? [`M${x} ${y}h1v1h-1z`] : []))).join("") };
  }, [text]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${path.size} ${path.size}`} shapeRendering="crispEdges" className="size-48 rounded-md bg-white text-black">
      <path d={path.d} fill="currentColor" />
    </svg>
  );
}

export function signInMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return OFFLINE;
  switch (err.code) {
    case "INVALID_CREDENTIALS":
      return "That username and password don't match. Check both and try again.";
    case "OTP_INVALID":
      return "That code didn't work. Enter the code your authenticator app shows now; each code works only once.";
    case "ACCOUNT_LOCKED": {
      const minutes = Math.max(1, Math.ceil(Number(err.details.retryAfterSeconds ?? 60) / 60));
      return `This account is locked after too many failed sign-ins. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}, or ask the system admin to unlock it.`;
    }
    case "ACCOUNT_DISABLED":
      return "This account has been turned off. Ask the system admin if you still need access.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many sign-in attempts from this network. Wait a few minutes, then try again.";
    default:
      return err.status >= 500 ? "Something went wrong on our side. Try again in a minute." : err.message;
  }
}
