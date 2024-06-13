import type { MetaFunction } from '@remix-run/node';
import { Link } from '@remix-run/react';
import Landing from '../components/landing';

export const meta: MetaFunction = () => {
	return [
		{ title: 'AnyGPT' },
		{
			name: 'description',
			content: 'Something about ai, idk'
		}
	];
};

export default function Index() {
	return (
		<main className="h-screen overflow-hidden">
			<Link to="/g" prefetch="render" />

			<Landing />
		</main>
	);
}
