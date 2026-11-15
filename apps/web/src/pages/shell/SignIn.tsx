/**
 * S-01 Sign in. Live builds use the API's own sign-in (A25): username and password, then the
 * authenticator code when the account has two-factor on, then the one first-sign-in step the API
 * may ask for (`next`): choose a new password. Two-factor is optional and set up in S-46 My
 * account, never here (A31). The app shell opens only when nothing is owed. The hosted demo
 * (`--mode demo`) keeps the role picker.
 * Background Beams is the one Aceternity piece the Design Brief allows here (first impression,
 * no working content); motion respects prefers-reduced-motion.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRightIcon, HardHatIcon, ShieldCheckIcon } from "lucide-react";
import { BackgroundBeams } from "@/components/aceternity/background-beams";
import { CodeInput, ErrorAlert, signInMessage } from "@/components/auth-parts";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { api, ApiError, type NextStep } from "@/lib/api";
import { DEMO_ACCOUNTS, ROLE_LABELS } from "@/lib/roles";
import { useSession } from "@/lib/session";
import { CLIENT_DEMO_NOTICE, isClientDemo } from "@/lib/deployment";
import { initials } from "@/components/nav-user";

const DEMO = import.meta.env.MODE === "demo";

export function SignIn() {
  const { account, next } = useSession();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  if (DEMO) return <DemoSignIn from={from} />;
  // App Flow front doors: the owner opens on the dashboard, office roles on Today.
  if (account && !next) return <Navigate to={from ?? (account.role === "owner" ? "/dashboard" : "/")} replace />;
  return <AuthLayout>{!account ? <PasswordStep /> : <ChangePasswordStep />}</AuthLayout>;
}

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">
      <BackgroundBeams className="pointer-events-none opacity-70" />
      <div className="relative z-10 w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <HardHatIcon className="size-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Manpower Management System</h1>
            <p className="text-sm text-muted-foreground">Workers, compliance, rosters, payroll and billing in one place.</p>
          </div>
        </div>
        <Card className="shadow-lg">{children}</Card>
      </div>
    </div>
  );
}

/** Card titles are the step headings, so screen readers can jump between steps. */
const StepTitle = ({ children }: { children: ReactNode }) => (
  <CardTitle role="heading" aria-level={2}>
    {children}
  </CardTitle>
);

function PasswordStep() {
  const { signInWithPassword, notice } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"password" | "otp">("password");
  const signIn = useMutation({
    mutationFn: () => signInWithPassword({ username: username.trim(), password, ...(step === "otp" ? { otp } : {}) }),
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : null;
      if (code === "OTP_REQUIRED") setStep("otp");
      else if (code === "OTP_INVALID") setOtp("");
      else if (code === "INVALID_CREDENTIALS") setPassword("");
    },
  });
  // OTP_REQUIRED isn't a failure: it is what moves the form to the code step.
  const error = signIn.error && !(signIn.error instanceof ApiError && signIn.error.code === "OTP_REQUIRED") ? signInMessage(signIn.error) : null;
  const errorId = "sign-in-error";
  const describedBy = error ? errorId : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate();
  };
  const back = () => {
    signIn.reset();
    setPassword("");
    setOtp("");
    setStep("password");
  };

  if (step === "otp")
    return (
      <form onSubmit={submit}>
        <CardHeader>
          <StepTitle>Enter your authenticator code</StepTitle>
          <CardDescription>Open the authenticator app on your phone and enter the 6-digit code it shows for this system.</CardDescription>
        </CardHeader>
        <CardContent className="mt-4 space-y-4">
          {error && <ErrorAlert id={errorId}>{error}</ErrorAlert>}
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="sign-in-otp">Authenticator code</FieldLabel>
            <CodeInput id="sign-in-otp" value={otp} onChange={setOtp} invalid={!!error} describedBy={describedBy} />
            <FieldDescription>Signing in as {username.trim()}. The code changes every 30 seconds.</FieldDescription>
          </Field>
        </CardContent>
        <CardFooter className="mt-4 flex-col gap-2">
          <Button type="submit" className="w-full" size="lg" disabled={signIn.isPending || otp.length !== 6}>
            Verify and sign in
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={back}>
            Use a different account
          </Button>
        </CardFooter>
      </form>
    );

  return (
    <form onSubmit={submit}>
      <CardHeader>
        <StepTitle>Sign in</StepTitle>
        <CardDescription>Use the username and password the system admin gave you.</CardDescription>
      </CardHeader>
      <CardContent className="mt-4 space-y-4">
        {isClientDemo() && <Alert>{CLIENT_DEMO_NOTICE}</Alert>}
        {error ? <ErrorAlert id={errorId}>{error}</ErrorAlert> : notice && <Alert>{notice}</Alert>}
        <FieldGroup className="gap-4">
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="sign-in-username">Username</FieldLabel>
            <Input
              id="sign-in-username"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              aria-invalid={!!error}
              aria-describedby={describedBy}
            />
          </Field>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="sign-in-password">Password</FieldLabel>
            <Input
              id="sign-in-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              aria-invalid={!!error}
              aria-describedby={describedBy}
            />
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="mt-4 flex-col gap-3">
        <Button type="submit" className="w-full" size="lg" disabled={signIn.isPending}>
          Sign in
        </Button>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon aria-hidden className="size-3.5" />
          Forgot your password? The system admin can reset it.
        </p>
      </CardFooter>
    </form>
  );
}

function SignOutLink() {
  const { signOut } = useSession();
  return (
    <Button type="button" variant="ghost" className="w-full" onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}

function ChangePasswordStep() {
  const { account, completeStep } = useSession();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const mismatch = submitted && confirm !== password ? "The two new passwords don't match." : null;
  const change = useMutation({
    mutationFn: () => api.post<{ next: NextStep }>("/api/auth/change-password", { currentPassword: current, newPassword: password }),
    onSuccess: (r) => {
      toast.success("Password changed");
      completeStep(r.next);
    },
  });
  const err = change.error instanceof ApiError ? change.error : null;
  const currentError = err?.code === "CURRENT_PASSWORD_WRONG" ? "That isn't the temporary password you were given." : null;
  const problems = err?.code === "PASSWORD_POLICY" && Array.isArray(err.details.problems) ? (err.details.problems as string[]) : err?.code === "PASSWORD_REUSED" ? [err.message] : [];
  const otherError = change.error && !currentError && !problems.length ? signInMessage(change.error) : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (confirm === password) change.mutate();
      }}
    >
      <CardHeader>
        <StepTitle>Choose a new password</StepTitle>
        <CardDescription>You signed in with a temporary password. Choose your own before you carry on.</CardDescription>
      </CardHeader>
      <CardContent className="mt-4 space-y-4">
        {otherError && <ErrorAlert id="change-password-error">{otherError}</ErrorAlert>}
        {/* Lets password managers save the new password against the right account. */}
        <input type="text" name="username" autoComplete="username" value={account?.username ?? ""} readOnly hidden />
        <FieldGroup className="gap-4">
          <Field data-invalid={!!currentError}>
            <FieldLabel htmlFor="cp-current">Temporary password</FieldLabel>
            <Input
              id="cp-current"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
              aria-invalid={!!currentError}
              aria-describedby={currentError ? "cp-current-error" : undefined}
            />
            {currentError && <FieldError id="cp-current-error">{currentError}</FieldError>}
          </Field>
          <Field data-invalid={problems.length > 0}>
            <FieldLabel htmlFor="cp-new">New password</FieldLabel>
            <Input
              id="cp-new"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              aria-invalid={problems.length > 0}
              aria-describedby={problems.length ? "cp-new-policy cp-new-error" : "cp-new-policy"}
            />
            <FieldDescription id="cp-new-policy">12 to 128 characters, and not containing your username. A few unrelated words make a strong password that is easy to remember.</FieldDescription>
            {problems.length > 0 && <FieldError id="cp-new-error" errors={problems.map((message) => ({ message }))} />}
          </Field>
          <Field data-invalid={!!mismatch}>
            <FieldLabel htmlFor="cp-confirm">Confirm new password</FieldLabel>
            <Input
              id="cp-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              aria-invalid={!!mismatch}
              aria-describedby={mismatch ? "cp-confirm-error" : undefined}
            />
            {mismatch && <FieldError id="cp-confirm-error">{mismatch}</FieldError>}
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="mt-4 flex-col gap-2">
        <Button type="submit" className="w-full" size="lg" disabled={change.isPending}>
          Save new password
        </Button>
        <SignOutLink />
      </CardFooter>
    </form>
  );
}

/** Demo stand-in (hosted demo only): pick one of the six Version 1 office roles. */
function DemoSignIn({ from }: { from?: string }) {
  const { account, signIn } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState(DEMO_ACCOUNTS[0]!.username);
  if (account) return <Navigate to={from ?? "/"} replace />;

  const submit = () => {
    const a = DEMO_ACCOUNTS.find((x) => x.username === username)!;
    signIn(a);
    // App Flow front doors: the owner opens on the dashboard, office roles on Today.
    navigate(from ?? (a.role === "owner" ? "/dashboard" : "/"), { replace: true });
  };

  return (
    <AuthLayout>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Demo accounts: choose a role to see the app the way that person does.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup value={username} onValueChange={setUsername} aria-label="Demo account" className="gap-2">
            {DEMO_ACCOUNTS.map((a) => (
              <Label
                key={a.username}
                htmlFor={`acct-${a.username}`}
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 transition-colors hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem id={`acct-${a.username}`} value={a.username} />
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">{initials(a.displayName)}</span>
                <span className="grid flex-1 leading-tight">
                  <span className="text-sm font-medium">{ROLE_LABELS[a.role]}</span>
                  <span className="text-xs font-normal text-muted-foreground">{a.displayName}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </CardContent>
        <CardFooter className="mt-4 flex-col gap-3">
          <Button type="submit" className="w-full" size="lg">
            Continue
            <ArrowRightIcon data-icon="inline-end" className="rtl:rotate-180" />
          </Button>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheckIcon className="size-3.5" />
            Demo only: live accounts sign in with a password, plus an authenticator code if they turned two-factor on.
          </p>
        </CardFooter>
      </form>
    </AuthLayout>
  );
}
