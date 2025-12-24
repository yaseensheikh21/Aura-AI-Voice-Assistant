
import React, { useEffect, useRef } from 'react';

interface WaveformProps {
  isActive: boolean;
  color?: string;
}

export const Waveform: React.FC<WaveformProps> = ({ isActive, color = '#3b82f6' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let offset = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const width = canvas.width;
      const height = canvas.height;
      const mid = height / 2;

      ctx.beginPath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';

      for (let x = 0; x < width; x++) {
        const angle = (x / width) * Math.PI * 4 + offset;
        const amplitude = isActive ? 15 : 2;
        const y = mid + Math.sin(angle) * amplitude;
        
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.stroke();
      offset += isActive ? 0.15 : 0.02;
      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [isActive, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={300} 
      height={100} 
      className="w-full h-24 opacity-80"
    />
  );
};
