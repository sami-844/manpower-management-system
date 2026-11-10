/**
 * S-46 My account (Settings, every signed-in user). Two-factor sign-in is optional (DECISIONS A31):
 * the user turns it on here with an authenticator app (`POST /api/auth/2fa/setup`, then `/confirm` with the
 * first code and their password) and off with their password and a fresh code (`POST /api/auth/2fa/disable`). Sign-in never asks
 * anyone to set it up. The hosted demo has no real sign-in, so it explains instead.
 */
import { useEffect, useRef, useState, type Ref } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
import { CodeInput, ErrorAlert, QrCode, signInMessage } from "@/components/auth-parts";
import { Page, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/roles";
import { useSession } from "@/lib/session";

const DEMO = import.meta.env.MODE === "demo";
const ME = ["auth", "me", "account"] as const;

export function Account() {
  const { account } = useSession();
  return (
    <Page>
      <PageHeader screen="S-46" title="My account" description="Your sign-in details, and two-factor sign-in if you want the extra protection." />
      <div className="grid max-w-2xl gap-6">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Account
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{account?.displayName}</dd>
              <dt className="text-muted-foreground">Username</dt>
              <dd className="font-mono">{account?.username}</dd>
              <dt className="text-muted-foreground">Role</dt>
              <dd>{account?.roles.map((r) => ROLE_LABELS[r]).join(", ")}</dd>
            </dl>
          </CardContent>
        </Card>
        {DEMO ? <DemoTwoFactor /> : <TwoFactor />}
      </div>
    </Page>
  );
}

const WHAT_IT_DOES =
  "Optional. When it's on, signing in also asks for a 6-digit code from an authenticator app on your phone, such as Microsoft Authenticator or Google Authenticator, so your password alone can't open your account.";

function DemoTwoFactor() {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Two-factor sign-in
        </CardTitle>
        <CardDescription>{WHAT_IT_DOES}</CardDescription>
      </CardHeader>
      <CardContent>
        <Alert>
          <AlertDescription>The demo has no real sign-in, so two-factor can't be turned on here. In the live system each person turns it on or off on this page.</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

type Setup = { secret: string; otpauthUrl: string };

function TwoFactor() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ME, queryFn: () => api.get<{ twoFactor: boolean }>("/api/auth/me") });
  const [mode, setMode] = useState<"view" | "on" | "off">("view");
  // Each call starts a fresh pending secret, so it runs once per click, never on render.
  const start = useMutation({ mutationFn: () => api.post<Setup>("/api/auth/2fa/setup"), onSuccess: () => setMode("on") });
  const action = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (mode === "view" && refocus.current) {
      refocus.current = false;
      action.current?.focus();
    }
  }, [mode, me.data]);
  const back = () => {
    refocus.current = true;
    start.reset();
    setMode("view");
  };
  const done = (message: string) => {
    toast.success(message);
    back();
    void qc.invalidateQueries({ queryKey: ME });
  };
  const on = me.data?.twoFactor === true;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle role="heading" aria-level={2}>
            Two-factor sign-in
          </CardTitle>
          {me.isSuccess && (on ? <StatusBadge tone="ok">On</StatusBadge> : <StatusBadge tone="incomplete">Off</StatusBadge>)}
        </div>
        <CardDescription>{WHAT_IT_DOES}</CardDescription>
      </CardHeader>
      {me.isPending ? (
        <CardContent>
          <Skeleton className="h-9 w-40" />
        </CardContent>
      ) : me.isError ? (
        <CardContent className="space-y-2">
          <ErrorAlert id="account-error">{signInMessage(me.error)}</ErrorAlert>
          <Button type="button" variant="outline" onClick={() => void me.refetch()}>
            Try again
          </Button>
        </CardContent>
      ) : mode === "on" && start.data ? (
        <TurnOn setup={start.data} onDone={() => done("Two-factor sign-in is on")} onCancel={back} />
      ) : mode === "off" ? (
        <TurnOff onDone={() => done("Two-factor sign-in is off")} onCancel={back} />
      ) : (
        <CardFooter className="flex-col items-start gap-3">
          {start.isError && <ErrorAlert id="setup-error">{signInMessage(start.error)}</ErrorAlert>}
          {on ? (
            <>
              <p className="text-sm text-muted-foreground">Lost or replaced your phone? Ask the system admin to reset two-factor, then turn it on again here.</p>
              <Button ref={action} type="button" variant="outline" onClick={() => setMode("off")}>
                <ShieldOffIcon data-icon="inline-start" />
                Turn off two-factor
              </Button>
            </>
          ) : (
            <Button ref={action} type="button" disabled={start.isPending} onClick={() => start.mutate()}>
              <ShieldCheckIcon data-icon="inline-start" />
              {start.isPending ? "Preparing your set-up code…" : "Turn on two-factor"}
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

/**
 * Field state for the turn-on and turn-off forms: a wrong password or code clears that field and
 * puts the cursor back in it (the submit button it came from stays disabled until it is filled again).
 */
function useConfirmFields() {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const onError = (e: unknown) => {
    const wrongPassword = e instanceof ApiError && e.code === "CURRENT_PASSWORD_WRONG";
    setCode("");
    if (wrongPassword) setPassword("");
    // After React has re-rendered the cleared, now-invalid field.
    requestAnimationFrame(() => (wrongPassword ? passwordRef : codeRef).current?.focus());
  };
  const messages = (error: unknown, wrongCode: string) => {
    const err = error instanceof ApiError ? error : null;
    const passwordError = err?.code === "CURRENT_PASSWORD_WRONG" ? "That isn't your current password." : null;
    const codeError = err?.code === "OTP_INVALID" ? wrongCode : null;
    const otherError = error && !passwordError && !codeError ? signInMessage(error) : null;
    return { passwordError, codeError, otherError };
  };
  return { password, setPassword, code, setCode, passwordRef, codeRef, onError, messages };
}

function PasswordField({
  id,
  value,
  onChange,
  error,
  inputRef,
  autoFocus = false,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  inputRef: Ref<HTMLInputElement>;
  autoFocus?: boolean;
}) {
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>Password</FieldLabel>
      <Input
        ref={inputRef}
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="current-password"
        required
        autoFocus={autoFocus}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

/** The pending secret takes effect only once a first code proves the app has it and the password proves it's the owner. */
function TurnOn({ setup, onDone, onCancel }: { setup: Setup; onDone: () => void; onCancel: () => void }) {
  const f = useConfirmFields();
  const confirm = useMutation({
    mutationFn: () => api.post("/api/auth/2fa/confirm", { password: f.password, code: f.code }),
    onSuccess: onDone,
    onError: f.onError,
  });
  const { passwordError, codeError, otherError } = f.messages(confirm.error, "That code didn't match. Enter the code the app shows now; it changes every 30 seconds.");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        confirm.mutate();
      }}
    >
      <CardContent className="space-y-5">
        {otherError && <ErrorAlert id="on-error">{otherError}</ErrorAlert>}
        <ol className="space-y-5 text-sm">
          <li className="space-y-3">
            <p>
              <span className="font-medium">1. Scan this code</span> with the app (add an account, then scan a QR code).
            </p>
            <div className="flex justify-center sm:justify-start">
              <QrCode text={setup.otpauthUrl} label="QR code for setting up your authenticator app" />
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">Can't scan it? Choose to enter a setup key, and type this key:</p>
              <p className="rounded-md bg-muted px-3 py-2 text-center font-mono text-base tracking-wider break-all" translate="no">
                {setup.secret.match(/.{1,4}/g)?.join(" ")}
              </p>
              <a href={setup.otpauthUrl} className="inline-block text-primary underline-offset-4 hover:underline">
                Open in an authenticator app on this device
              </a>
            </div>
          </li>
          <li>
            <Field data-invalid={!!codeError}>
              <FieldLabel htmlFor="setup-code">
                <span className="font-medium">2. Code from the app</span>
              </FieldLabel>
              <CodeInput id="setup-code" inputRef={f.codeRef} value={f.code} onChange={f.setCode} invalid={!!codeError} describedBy={codeError ? "setup-code-error" : undefined} />
              {codeError ? <FieldError id="setup-code-error">{codeError}</FieldError> : <FieldDescription>Enter the 6-digit code the app now shows for this system.</FieldDescription>}
            </Field>
          </li>
          <li className="space-y-2">
            <p className="font-medium">3. Confirm it's you</p>
            <PasswordField id="on-password" inputRef={f.passwordRef} value={f.password} onChange={f.setPassword} error={passwordError} />
          </li>
        </ol>
      </CardContent>
      <CardFooter className="mt-4 flex-wrap gap-2">
        <Button type="submit" disabled={confirm.isPending || f.code.length !== 6 || !f.password}>
          Turn on two-factor
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </CardFooter>
    </form>
  );
}

function TurnOff({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const f = useConfirmFields();
  const off = useMutation({
    mutationFn: () => api.post("/api/auth/2fa/disable", { password: f.password, code: f.code }),
    onSuccess: onDone,
    onError: f.onError,
  });
  const { passwordError, codeError, otherError } = f.messages(off.error, "That code didn't work. Enter the code your authenticator app shows now; each code works only once.");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        off.mutate();
      }}
    >
      <CardContent className="space-y-4">
        <p className="text-sm">To turn two-factor off, confirm it's you with your password and a code from the app.</p>
        {otherError && <ErrorAlert id="off-error">{otherError}</ErrorAlert>}
        <FieldGroup className="gap-4">
          <PasswordField id="off-password" inputRef={f.passwordRef} value={f.password} onChange={f.setPassword} error={passwordError} autoFocus />
          <Field data-invalid={!!codeError}>
            <FieldLabel htmlFor="off-code">Authenticator code</FieldLabel>
            <CodeInput id="off-code" inputRef={f.codeRef} value={f.code} onChange={f.setCode} invalid={!!codeError} describedBy={codeError ? "off-code-error" : undefined} autoFocus={false} />
            {codeError && <FieldError id="off-code-error">{codeError}</FieldError>}
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="mt-4 flex-wrap gap-2">
        <Button type="submit" variant="destructive" disabled={off.isPending || !f.password || f.code.length !== 6}>
          Turn off two-factor
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </CardFooter>
    </form>
  );
}
