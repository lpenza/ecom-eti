import React from 'react';

function Toast({ message, type = 'info' }) {
  const className = `toast toast-${type} show`;
  
  return (
    <div className={className}>
      {message}
    </div>
  );
}

export default Toast;
