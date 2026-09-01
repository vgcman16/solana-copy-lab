import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="CopyLab home">
      <span className="brand-mark"><Icon name="activity" size={20} /></span>
      {!compact && <span className="brand-word">Copy<span>Lab</span></span>}
    </div>
  );
}

export function Button({
  children,
  tone = "secondary",
  icon,
  busy = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "danger" | "ghost";
  icon?: IconName;
  busy?: boolean;
}) {
  return (
    <button className={`button button-${tone} ${className}`} {...props} disabled={busy || props.disabled}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

export function StatusDot({ ok, label }: { ok: boolean | "warning"; label?: string }) {
  return <span className={`status-dot ${ok === true ? "ok" : ok === "warning" ? "warning" : "bad"}`} aria-label={label} />;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="section-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
        {description && <p className="section-description">{description}</p>}
      </div>
      {action && <div className="section-action">{action}</div>}
    </header>
  );
}

export function EmptyState({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  children,
  onClose,
  danger = false
}: {
  open: boolean;
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  danger?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className={`modal ${danger ? "modal-danger" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog"><Icon name="close" size={18} /></button>
        <span className="modal-symbol"><Icon name={danger ? "alert" : "shield"} size={22} /></span>
        <h2 id="modal-title">{title}</h2>
        <p>{description}</p>
        {children}
      </section>
    </div>
  );
}
