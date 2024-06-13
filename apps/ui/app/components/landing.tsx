import { Button } from '@/components/ui/button';
import React, { useState } from 'react';

export default function Landing() {
	const [message, setMessage] = useState('');
	const [response, setResponse] = useState('');

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		fetch('/gemini', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ message })
		})
			.then(response => response.json())
			.then(data => {
				console.log(data);
				setResponse(data.message);
			})
			.catch(error => {
				console.error('Error:', error);
			});
	};

	return (
		<div className="h-screen w-screen select-none">
			<link rel="preconnect" href="https://fonts.googleapis.com" />
			<link rel="preconnect" href="https://fonts.gstatic.com" />
			<link
				href="https://fonts.googleapis.com/css2?family=Italianno&display=swap"
				rel="stylesheet"
			/>

			<div
				className={`default-bg absolute bottom-[-10vh] left-[-10vw] h-[120vh] w-[120vw] select-none`}
			></div>

			<form
				id="geminiForm"
				onSubmit={handleSubmit}
				className="absolute z-10"
			>
				<input
					type="text"
					id="message"
					style={{ width: '85%' }}
					name="message"
					placeholder="Enter your message here"
					value={message}
					onChange={e => setMessage(e.target.value)}
					className="text-black"
				/>
				<button type="submit">Send</button>
				<hr />
				<div id="response">{response}</div>
			</form>

			<script src="https://cdn.jsdelivr.net/particles.js/2.0.0/particles.min.js"></script>
			<a
				href="https://discord.gg/6FqaQxFEKp"
				className="absolute bottom-[0.5rem] left-[0.5rem] z-10"
			>
				<Button variant="outline" className="flex size-10 flex-col">
					<svg
						className="button-content size-40"
						width="256px"
						height="256px"
						viewBox="0 0 192 192"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
					>
						<g id="SVGRepo_bgCarrier" strokeWidth="0"></g>
						<g
							id="SVGRepo_tracerCarrier"
							strokeLinecap="round"
							strokeLinejoin="round"
						></g>
						<g id="SVGRepo_iconCarrier">
							<path
								stroke="#fff"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="12.48"
								d="m68 138-8 16c-10.19-4.246-20.742-8.492-31.96-15.8-3.912-2.549-6.284-6.88-6.378-11.548-.488-23.964 5.134-48.056 19.369-73.528 1.863-3.334 4.967-5.778 8.567-7.056C58.186 43.02 64.016 40.664 74 39l6 11s6-2 16-2 16 2 16 2l6-11c9.984 1.664 15.814 4.02 24.402 7.068 3.6 1.278 6.704 3.722 8.567 7.056 14.235 25.472 19.857 49.564 19.37 73.528-.095 4.668-2.467 8.999-6.379 11.548-11.218 7.308-21.769 11.554-31.96 15.8l-8-16m-68-8s20 10 40 10 40-10 40-10"
							></path>
							<ellipse
								cx="71"
								cy="101"
								fill="#fff"
								rx="13"
								ry="15"
							></ellipse>
							<ellipse
								cx="121"
								cy="101"
								fill="#fff"
								rx="13"
								ry="15"
							></ellipse>
						</g>
					</svg>
				</Button>
				<span className="absolute bottom-[0.5rem] left-[3rem] z-10">
					Discord
				</span>
			</a>
		</div>
	);
}
