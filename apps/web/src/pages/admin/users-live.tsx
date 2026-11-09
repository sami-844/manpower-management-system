/**
 * S-36 against the real admin endpoints (`/api/admin/users`, permission `users.manage`), used by
 * every build except the hosted demo. Temporary passwords are shown once, then dropped: they are
 * held in component state only while their dialog is open, never in the query cache.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CopyIcon, MoreHorizontalIcon, ShieldCheckIcon, ShieldOffIcon, UserPlusIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { ROLE_LABELS, V1_ROLES, type V1Role } from "@/lib/roles";
import { ROLE_DESCRIPTIONS } from "@/demo/admin";
import { displayMoment } from "@/demo/insight";
import { createColumns, DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  isPasswordChangeRequired: boolean;
  hasTotp: boolean;
  lockedUntil: string | null;
  isLocked: boolean;
  lastSignInAt: string | null;
  roles: { role: string; entityId: string }[];
}

const KEY = ["admin-users", "live"];
export const useAdminUsers = (enabled: boolean) =>
  useQuery({ queryKey: KEY, queryFn: () => api.get<{ items: AdminUser[] }>("/api/admin/users").then((r) => r.items), enabled });

const roleKeys = (u: AdminUser) => V1_ROLES.filter((r) => u.roles.some((x) => x.role === r));
const roleText = (u: AdminUser) => roleKeys(u).map((r) => ROLE_LABELS[r]).join(", ") || "No role";
const failed = (what: string) => (e: unknown) =>
  toast.error(what, { description: e instanceof ApiError ? e.message : "The server didn't respond. Check your connection and try again." });

// ── Temporary password, shown once ───────────────────────────────────────────

interface Shown {
  name: string;
  password: string;
}

function TemporaryPasswordDialog({ shown, onClose }: { shown: Shown | null; onClose: () => void }) {
  const copy = () =>
    navigator.clipboard.writeText(shown!.password).then(
      () => toast.success("Password copied"),
      () => toast.error("Couldn't copy. Select the password and copy it by hand."),
    );
  return (
    <Dialog open={!!shown} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Temporary password for {shown?.name}</DialogTitle>
          <DialogDescription>
            This is the only time this password is shown. Give it to {shown?.name} in person or by phone, not by email. They choose their own password the first time they sign in.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md bg-muted px-3 py-2 text-center font-mono text-base break-all" translate="no">
            {shown?.password}
          </code>
          <Button type="button" variant="outline" onClick={() => void copy()} aria-label="Copy password">
            <CopyIcon aria-hidden /> Copy
          </Button>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Roles picker (create and change roles) ───────────────────────────────────

function RolesField({ value, onChange, error }: { value: V1Role[]; onChange: (roles: V1Role[]) => void; error: string | null }) {
  return (
    <FieldSet data-invalid={!!error}>
      <FieldLegend variant="label">Roles</FieldLegend>
      <FieldDescription>Choose every role this person does. They see the areas of all of them.</FieldDescription>
      <FieldGroup className="gap-3">
        {V1_ROLES.map((r) => (
          <Field key={r} orientation="horizontal">
            <Checkbox
              id={`role-${r}`}
              checked={value.includes(r)}
              onCheckedChange={(on) => onChange(on ? [...value, r] : value.filter((x) => x !== r))}
              aria-describedby={`role-${r}-desc`}
            />
            <div className="grid gap-0.5">
              <FieldLabel htmlFor={`role-${r}`}>{ROLE_LABELS[r]}</FieldLabel>
              <p id={`role-${r}-desc`} className="text-xs text-muted-foreground">
                {ROLE_DESCRIPTIONS[r]}
              </p>
            </div>
          </Field>
        ))}
      </FieldGroup>
      {error && <FieldError>{error}</FieldError>}
    </FieldSet>
  );
}

// ── Create ───────────────────────────────────────────────────────────────────

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,49}$/;

export function CreateUserDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<V1Role[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const clean = username.trim().toLowerCase();
  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: AdminUser; temporaryPassword: string }>("/api/admin/users", {
        username: clean,
        displayName: name.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        roles,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      setShown({ name: r.user.displayName, password: r.temporaryPassword });
      create.reset(); // drop the password from the mutation cache
      setOpen(false);
      reset();
    },
  });
  const server = create.error instanceof ApiError ? create.error : null;
  const issue = (path: string) => server?.issues.find((i) => i.path === path)?.message ?? null;
  const invalid = {
    username: USERNAME.test(clean) ? null : "Use 3 to 50 characters: letters, digits, dot, dash or underscore.",
    name: name.trim().length >= 2 ? null : "Enter the person's full name.",
    email: !email.trim() || /^\S+@\S+\.\S+$/.test(email.trim()) ? null : "Enter a valid email address, or leave it empty.",
    roles: roles.length ? null : "Choose at least one role.",
  };
  const errors = {
    username: (submitted && invalid.username) || (server?.code === "USERNAME_TAKEN" ? "That username is already in use. Choose another." : issue("username")),
    name: (submitted && invalid.name) || issue("displayName"),
    email: (submitted && invalid.email) || issue("email"),
    roles: (submitted && invalid.roles) || issue("roles"),
  };
  const other = create.error && !Object.values(errors).some(Boolean) ? (server?.message ?? "The server didn't respond. Check your connection and try again.") : null;
  function reset() {
    setUsername("");
    setName("");
    setEmail("");
    setRoles([]);
    setSubmitted(false);
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            reset();
            create.reset();
          }
        }}
      >
        <DialogTrigger asChild>
          <Button>
            <UserPlusIcon aria-hidden /> Add user
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a user</DialogTitle>
            <DialogDescription>You'll get a temporary password to pass on. At first sign-in they choose their own password and set up an authenticator app.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(true);
              create.reset();
              if (!Object.values(invalid).some(Boolean)) create.mutate();
            }}
          >
            <FieldGroup className="gap-4">
              {other && (
                <Alert variant="destructive">
                  <AlertDescription>{other}</AlertDescription>
                </Alert>
              )}
              <Field data-invalid={!!errors.username}>
                <FieldLabel htmlFor="nu-username">Username</FieldLabel>
                <Input
                  id="nu-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={!!errors.username}
                  aria-describedby="nu-username-desc"
                  autoFocus
                />
                <FieldDescription id="nu-username-desc">What they type to sign in, for example fatima.hr.</FieldDescription>
                {errors.username && <FieldError>{errors.username}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="nu-name">Full name</FieldLabel>
                <Input id="nu-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" aria-invalid={!!errors.name} />
                {errors.name && <FieldError>{errors.name}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.email}>
                <FieldLabel htmlFor="nu-email">Work email (optional)</FieldLabel>
                <Input id="nu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" aria-invalid={!!errors.email} />
                {errors.email && <FieldError>{errors.email}</FieldError>}
              </Field>
              <RolesField value={roles} onChange={setRoles} error={errors.roles || null} />
            </FieldGroup>
            <DialogFooter className="mt-6">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={create.isPending}>
                Create user
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <TemporaryPasswordDialog shown={shown} onClose={() => setShown(null)} />
    </>
  );
}

// ── Change roles ─────────────────────────────────────────────────────────────

function RolesDialog({ user, open, onOpenChange }: { user: AdminUser; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [roles, setRoles] = useState<V1Role[]>(() => roleKeys(user));
  const save = useMutation({
    mutationFn: () => api.put(`/api/admin/users/${user.id}/roles`, { roles }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(`Roles changed for ${user.displayName}`, { description: "They see the change the next time their session renews, within 15 minutes." });
      onOpenChange(false);
    },
  });
  const error = !roles.length ? "Choose at least one role. To stop someone signing in, disable the account instead." : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) setRoles(roleKeys(user));
        else save.reset();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Roles for {user.displayName}</DialogTitle>
          <DialogDescription>Roles decide which areas {user.displayName} can open.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!error) save.mutate();
          }}
        >
          {save.error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{save.error instanceof ApiError ? save.error.message : "The server didn't respond. Check your connection and try again."}</AlertDescription>
            </Alert>
          )}
          <RolesField value={roles} onChange={setRoles} error={error} />
          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!!error || save.isPending}>
              Save roles
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Row actions ──────────────────────────────────────────────────────────────

type Confirm = "reset-password" | "reset-2fa" | "disable";

function RowActions({ u }: { u: AdminUser }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: KEY });
  const act = (path: string, success: string, description?: string) =>
    api.post(`/api/admin/users/${u.id}/${path}`).then(() => {
      done();
      toast.success(success, { description });
    }, failed("That didn't work"));

  const resetPassword = useMutation({
    mutationFn: () => api.post<{ temporaryPassword: string }>(`/api/admin/users/${u.id}/reset-password`),
    onSuccess: (r) => {
      done();
      setShown({ name: u.displayName, password: r.temporaryPassword });
      resetPassword.reset(); // drop the password from the mutation cache
    },
    onError: failed("Couldn't reset the password"),
  });

  const confirmText: Record<Confirm, { title: string; description: string; action: string; run: () => void; destructive?: boolean }> = {
    "reset-password": {
      title: `Reset ${u.displayName}'s password?`,
      description: "Their current password stops working and they are signed out everywhere. You'll get a temporary password to pass on; they choose a new one at next sign-in.",
      action: "Reset password",
      run: () => resetPassword.mutate(),
    },
    "reset-2fa": {
      title: `Reset two-factor for ${u.displayName}?`,
      description: "Use this when they've lost or replaced their phone. They set up an authenticator app again the next time they sign in.",
      action: "Reset two-factor",
      run: () => void act("reset-2fa", `Two-factor reset for ${u.displayName}`, "They set it up again at next sign-in."),
    },
    disable: {
      title: `Disable ${u.displayName}'s account?`,
      description: "They are signed out everywhere and can't sign in until you enable the account again. Their records and history stay.",
      action: "Disable account",
      run: () => void act("disable", `${u.displayName} can no longer sign in`),
      destructive: true,
    },
  };
  const c = confirm ? confirmText[confirm] : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.displayName}`} onClick={(e) => e.stopPropagation()}>
            <MoreHorizontalIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRolesOpen(true)}>Change roles…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfirm("reset-password")}>Reset password…</DropdownMenuItem>
          {u.hasTotp && <DropdownMenuItem onSelect={() => setConfirm("reset-2fa")}>Reset two-factor…</DropdownMenuItem>}
          {u.isLocked && <DropdownMenuItem onSelect={() => void act("unlock", `${u.displayName} is unlocked`, "They can sign in again now.")}>Unlock</DropdownMenuItem>}
          <DropdownMenuSeparator />
          {u.status === "disabled" ? (
            <DropdownMenuItem onSelect={() => void act("enable", `${u.displayName} can sign in again`)}>Enable account</DropdownMenuItem>
          ) : (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("disable")}>
              Disable account…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={!!c} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{c?.title}</AlertDialogTitle>
            <AlertDialogDescription>{c?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={c?.destructive ? "destructive" : "default"} onClick={() => c?.run()}>
              {c?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RolesDialog user={u} open={rolesOpen} onOpenChange={setRolesOpen} />
      <TemporaryPasswordDialog shown={shown} onClose={() => setShown(null)} />
    </>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

function StatusCell({ u }: { u: AdminUser }): ReactNode {
  if (u.status === "disabled") return <StatusBadge tone="blocked">Disabled</StatusBadge>;
  if (u.isLocked) return <StatusBadge tone="locked">Locked</StatusBadge>;
  if (u.isPasswordChangeRequired) return <StatusBadge tone="due">New password due</StatusBadge>;
  return <StatusBadge tone="ok">Active</StatusBadge>;
}

const col = createColumns<AdminUser>();
const columns = col.columns([
  col.accessor("displayName", {
    header: "User",
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{row.original.displayName}</div>
        <div className="truncate text-xs text-muted-foreground">{row.original.email ?? row.original.username}</div>
      </div>
    ),
  }),
  col.display({ id: "roles", header: "Roles", cell: ({ row }) => roleText(row.original) }),
  col.accessor("status", { header: "Status", cell: ({ row }) => <StatusCell u={row.original} /> }),
  col.accessor("hasTotp", {
    header: "Two-factor",
    cell: (c) =>
      c.getValue() ? (
        <span className="inline-flex items-center gap-1 text-sm">
          <ShieldCheckIcon aria-hidden className="size-4 text-success" /> On
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <ShieldOffIcon aria-hidden className="size-4" /> Not set up
        </span>
      ),
  }),
  col.accessor("lastSignInAt", { header: "Last sign-in", cell: (c) => <span className="whitespace-nowrap tabular-nums">{c.getValue() ? displayMoment(c.getValue()) : "Never"}</span> }),
  col.display({ id: "actions", header: () => <span className="sr-only">Actions</span>, cell: ({ row }) => <RowActions u={row.original} /> }),
]);

export function LiveUsersTable({ users, loading }: { users: AdminUser[] | undefined; loading: boolean }) {
  return (
    <DataTable
      label="Users"
      columns={columns}
      data={users}
      loading={loading}
      getRowId={(u) => u.id}
      search={(u, q) => u.displayName.toLowerCase().includes(q) || u.username.includes(q) || roleText(u).toLowerCase().includes(q)}
      searchPlaceholder="Filter by name, username or role…"
      empty="No users yet. Add the first office user."
    />
  );
}
