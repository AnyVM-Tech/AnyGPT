import * as React from 'react';

import { cn } from '@/lib/utils';

export interface InputProps
	extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
	({ className, type, ...props }, ref) => {
		return (
			<input
				type={type}
				className={cn(
					'hover:input-text-blur focus-visible:input-text-blur placeholder:text-muted-foreground flex h-10 w-full rounded-md border bg-[var(--background-dark)] px-3 py-2 text-sm text-opacity-70 transition-all duration-300 file:bg-transparent file:text-sm file:font-medium hover:border-[var(--border-light)] hover:shadow-[0_0_25px_5px_rgba(30,41,59,1)_inset] focus-visible:border-[var(--border-light)] focus-visible:shadow-[0_0_25px_5px_rgba(30,41,59,1)_inset] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
					className
				)}
				ref={ref}
				{...props}
			/>
		);
	}
);
Input.displayName = 'Input';

export { Input };
