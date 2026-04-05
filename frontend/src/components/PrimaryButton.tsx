interface PrimaryButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export default function PrimaryButton({ children, onClick, disabled, className = '' }: PrimaryButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        w-full h-13 rounded-xl font-semibold text-base transition-all flex items-center justify-center gap-2
        ${disabled 
          ? 'bg-dark-border text-text-tertiary cursor-not-allowed'
          : 'bg-gradient-to-r from-orange to-orange-light text-white shadow-lg shadow-orange/30 hover:shadow-orange/40 active:scale-95'
        }
        ${className}
      `}
    >
      {children}
    </button>
  );
}
