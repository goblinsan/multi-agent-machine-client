import React from 'react';
import { render } from '@testing-library/react';
import App from './App';

describe('App', () => {
  test('renders without crashing', () => {
    const { container } = render(<App />);
    expect(container).toBeInTheDocument();
  });

  test('renders with correct content', () => {
    const { getByText } = render(<App />);
    expect(getByText(/machine client log summarizer/i)).toBeInTheDocument();
  });
});
