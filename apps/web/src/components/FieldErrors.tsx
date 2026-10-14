import { ApiError } from "../lib/api";

const FIELD_NAMES: Record<string, string> = {
  fullName: "Full name",
  nationality: "Nationality",
  trade: "Trade",
  expiryDate: "Expiry date",
  issueDate: "Issue date",
  from: "From",
  to: "To",
  reason: "Reason",
};

/** Say what is wrong and where, in the interface's voice. */
export function FieldErrors({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError && error.issues.length > 0) {
    return (
      <ul className="form-errors" role="alert">
        {error.issues.map((i) => (
          <li key={i.path + i.message}>
            {FIELD_NAMES[i.path] ?? i.path}: {i.message}
          </li>
        ))}
      </ul>
    );
  }
  const message = error instanceof ApiError ? error.message : "The server didn't respond. Check your connection and try again.";
  return (
    <p className="form-errors" role="alert">
      {message}
    </p>
  );
}
