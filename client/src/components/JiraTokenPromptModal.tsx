import { KeyRound, Loader2, LogOut } from 'lucide-react';
import CommonModal from './CommonModal';

type JiraTokenPromptModalProps = {
  open: boolean;
  tokenDraft: string;
  saving: boolean;
  onTokenChange: (value: string) => void;
  onSave: () => void;
  onLogout?: () => void;
};

export default function JiraTokenPromptModal({
  open,
  tokenDraft,
  saving,
  onTokenChange,
  onSave,
  onLogout,
}: JiraTokenPromptModalProps) {
  return (
    <CommonModal
      open={open}
      onClose={() => {}}
      title={
        <span className="jira-token-prompt__title">
          <KeyRound size={22} aria-hidden />
          Cập nhật Jira Token (bắt buộc)
        </span>
      }
      titleId="jira-token-prompt-modal-title"
      classNameContent="jira-token-prompt-modal"
      closeOnOverlayClick={false}
      closeOnEscape={false}
      showCloseButton={false}
      closeDisabled
      zIndex={1250}
    >
      <p className="jira-token-prompt__intro">
        Để sử dụng app, bạn cần <strong>Jira Personal Access Token</strong> của tài khoản Jira cá
        nhân. Dán token và bấm <strong>Lưu token</strong> để tiếp tục.
      </p>
      <label className="jira-token-prompt__field">
        <span className="jira-token-prompt__label">Jira Token</span>
        <input
          type="password"
          value={tokenDraft}
          onChange={e => onTokenChange(e.target.value)}
          placeholder="Dán Personal Access Token từ Jira"
          className="ticket-field ticket-field--medium"
          autoComplete="off"
          style={{ minHeight: '40px' }}
          disabled={saving}
        />
      </label>
      <p className="jira-token-prompt__hint">
        Jira → Profile → Personal Access Tokens. Token được lưu trên server cho các thao tác sau
        này.
      </p>
      <div className="jira-token-prompt__actions jira-token-prompt__actions--required">
        {onLogout && (
          <button
            type="button"
            className="jira-token-prompt__btn jira-token-prompt__btn--secondary"
            onClick={() => onLogout()}
            disabled={saving}
          >
            <LogOut size={16} />
            Đăng xuất
          </button>
        )}
        <button
          type="button"
          className="jira-token-prompt__btn jira-token-prompt__btn--primary"
          onClick={() => void onSave()}
          disabled={saving}
        >
          {saving ? <Loader2 size={16} className="spinner" /> : <KeyRound size={16} />}
          Lưu token
        </button>
      </div>
    </CommonModal>
  );
}
