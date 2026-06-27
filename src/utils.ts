import fs from 'fs';
import path from 'path';

/**
 * Guarda o actualiza una variable en el archivo .env de la raíz del proyecto.
 * @param key Clave de la variable
 * @param value Valor a almacenar
 */
export function saveToEnv(key: string, value: string) {
  const envPath = path.join(process.cwd(), '.env');
  let content = '';
  
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }

  const lines = content.split('\n');
  let keyFound = false;
  
  const newLines = lines.map(line => {
    const parts = line.split('=');
    if (parts.length >= 2 && parts[0].trim() === key) {
      keyFound = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!keyFound) {
    if (content.length > 0 && !content.endsWith('\n')) {
      newLines.push('');
    }
    newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, newLines.join('\n'), 'utf8');
}
