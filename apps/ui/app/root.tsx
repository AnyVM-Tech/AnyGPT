import {
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration
} from '@remix-run/react';
import './globals.css';

import { useEffect } from 'react';

export function Layout({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		console.log(`
                it works
        `);
	}, []);
	return (
		<html lang="en" className="dark">
			<head>
				<meta charSet="utf-8" />
				<meta
					name="viewport"
					content="width=device-width, initial-scale=1"
				/>

				<Meta />
				<Links />
			</head>
			<body>
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	return <Outlet />;
}
