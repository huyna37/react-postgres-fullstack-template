import Swal from 'sweetalert2';

/** Luôn cao hơn CommonModal (tối đa ~1300). */
export const SWAL_Z_INDEX = 2000;

/** Theme chung cho SweetAlert2 (import khi cần Swal.fire tùy chỉnh). */
export const swalConfig = {
  background: '#1e293b',
  color: '#f8fafc',
  width: '500px',
  padding: '1rem',
  customClass: {
    title: 'swal2-title-small',
    htmlContainer: 'swal2-html-small',
    confirmButton: 'swal2-confirm-small',
    cancelButton: 'swal2-cancel-small'
  }
};

export const showSuccess = (message: string) => {
  return Swal.fire({
    ...swalConfig,
    title: 'Thành công!',
    text: message,
    icon: 'success',
    confirmButtonColor: '#6366f1'
  });
};

export const showToast = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success', duration: number = 3000) => {
  const Toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: duration,
    timerProgressBar: true,
    background: '#1e293b',
    color: '#f8fafc',
    didOpen: (toast) => {
      toast.addEventListener('mouseenter', Swal.stopTimer)
      toast.addEventListener('mouseleave', Swal.resumeTimer)
    }
  });

  return Toast.fire({
    icon: type,
    title: message
  });
};

export const showError = (message: string) => {
  return Swal.fire({
    ...swalConfig,
    title: 'Lỗi!',
    text: message,
    icon: 'error',
    confirmButtonColor: '#6366f1'
  });
};

export const showWarning = (message: string) => {
  return Swal.fire({
    ...swalConfig,
    title: 'Cảnh báo',
    text: message,
    icon: 'warning',
    confirmButtonColor: '#f59e0b'
  });
};

export const showConfirm = (title: string, text: string = '') => {
  return Swal.fire({
    ...swalConfig,
    title,
    text,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#6366f1',
    cancelButtonColor: '#ef4444',
    confirmButtonText: 'Đồng ý',
    cancelButtonText: 'Hủy'
  });
};
type ShowPromptOptions = {
  confirmButtonText?: string;
};

export const showPrompt = (title: string, placeholder: string, options?: ShowPromptOptions) => {
  return Swal.fire({
    ...swalConfig,
    title,
    input: 'textarea',
    inputPlaceholder: placeholder,
    showCancelButton: true,
    confirmButtonColor: '#6366f1',
    cancelButtonColor: '#ef4444',
    confirmButtonText: options?.confirmButtonText ?? 'Bắt đầu Fix',
    cancelButtonText: 'Hủy',
    width: 'min(520px, calc(100vw - 24px))',
    inputAttributes: {
      'aria-label': placeholder,
      'style': 'background: #0f172a; color: white; border: 1px solid #334155; font-size: 0.9rem; box-sizing: border-box; max-width: 100%; min-height: 100px; overflow-wrap: break-word; word-break: break-word; line-height: 1.5; padding: 0.75rem;'
    }
  });
};
