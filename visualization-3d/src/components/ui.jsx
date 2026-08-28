// 기존 시각화도구/index.html의 UI 프리미티브를 그대로 이식.

export function Button({ children, onClick, className = '', variant = 'default', size = 'default', disabled = false, ...props }) {
  const baseClasses = 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50';

  const variants = {
    default: 'bg-blue-600 text-white shadow-sm hover:bg-blue-700',
    outline: 'border border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-800 hover:text-white',
    secondary: 'bg-slate-700 text-slate-200 hover:bg-slate-600',
  };

  const sizes = {
    default: 'h-9 px-4 py-2',
    sm: 'h-8 px-3 py-1.5 text-xs',
  };

  const classes = `${baseClasses} ${variants[variant]} ${sizes[size]} ${className}`;

  return (
    <button className={classes} onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  );
}

export function Card({ children, className = '' }) {
  return (
    <div className={`bg-slate-900/50 border border-slate-800 rounded-xl backdrop-blur-sm ${className}`}>
      {children}
    </div>
  );
}

export function Textarea({ value, onChange, placeholder, className = '', ...props }) {
  return (
    <textarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={`w-full p-3 bg-slate-950/50 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 ${className}`}
      {...props}
    />
  );
}

export function Checkbox({ checked, onChange, id, className = '' }) {
  return (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className={`w-4 h-4 bg-slate-800 border border-slate-600 rounded focus:ring-2 focus:ring-blue-500 checked:bg-blue-600 checked:border-blue-600 ${className}`}
    />
  );
}

export function Badge({ children, variant = 'default', className = '' }) {
  const variants = {
    default: 'bg-slate-800/50 text-slate-300 border-slate-700',
    secondary: 'bg-blue-900/50 text-blue-300 border-blue-800',
  };

  return (
    <span className={`inline-flex items-center px-2 py-1 text-xs font-medium border rounded-md ${variants[variant]} ${className}`}>
      {children}
    </span>
  );
}
