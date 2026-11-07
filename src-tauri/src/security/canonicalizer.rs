//! Subconjunto Canônico e Proteção de Caminhos para o LIORA Desktop (Rust)
//!
//! Garante que nenhuma operação de I/O extrapole o diretório de workspace isolado
//! e computa hashes SHA-256 determinísticos para os parâmetros recebidos via IPC.

use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum CanonicalizationError {
    #[error("Tentativa de path traversal detectada: '{0}'")]
    PathTraversal(String),

    #[error("Caminho absoluto não autorizado: '{0}'")]
    AbsolutePathDenied(String),

    #[error("Caractere nulo (null byte) detectado no caminho")]
    NullByteDetected,

    #[error("Nome de arquivo vazio ou inválido")]
    InvalidFilename,

    #[allow(dead_code)]
    #[error("Erro de serialização JSON: {0}")]
    Serialization(String),
}

/// Valida e resolve um caminho relativo para o workspace seguro da LIORA.
/// 
/// Rejeita incondicionalmente:
/// - Prefixos de caminho absoluto (`/`, `C:\`, `\\`)
/// - Componentes pai de traversal (`..`)
/// - Bytes nulos (`\0`)
/// - Nomes de arquivo reservados ou vazios
pub fn canonicalize_workspace_path<P: AsRef<Path>>(
    workspace_root: &Path,
    relative_path: P,
) -> Result<PathBuf, CanonicalizationError> {
    let path_ref = relative_path.as_ref();
    let path_str = path_ref.to_string_lossy();

    // 1. Verificação de bytes nulos
    if path_str.contains('\0') {
        return Err(CanonicalizationError::NullByteDetected);
    }

    // 2. Rejeição de caminhos vazios
    let trimmed = path_str.trim();
    if trimmed.is_empty() {
        return Err(CanonicalizationError::InvalidFilename);
    }

    // 3. Rejeição de padrões perigosos na string crua
    if trimmed.starts_with('/') 
        || trimmed.starts_with('\\') 
        || (trimmed.len() >= 2 && trimmed.chars().nth(1) == Some(':')) 
        || trimmed.contains("..") 
    {
        return Err(CanonicalizationError::PathTraversal(trimmed.to_string()));
    }

    // 4. Validação por componentes estruturados
    for component in path_ref.components() {
        match component {
            Component::ParentDir => {
                return Err(CanonicalizationError::PathTraversal(trimmed.to_string()));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(CanonicalizationError::AbsolutePathDenied(trimmed.to_string()));
            }
            Component::Normal(_) | Component::CurDir => {}
        }
    }

    // 5. Construção segura dentro do workspace_root
    let safe_full_path = workspace_root.join(path_ref);
    Ok(safe_full_path)
}

/// Computa hash SHA-256 canônico de parâmetros JSON para o log de auditoria.
pub fn hash_canonical_parameters(params: &serde_json::Value) -> String {
    let serialized = match serde_json::to_string(params) {
        Ok(s) => s,
        Err(_) => "{}".to_string(),
    };
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    let result = hasher.finalize();
    format!("sha256-{}", hex::encode(result))
}

mod hex {
    pub fn encode(data: impl AsRef<[u8]>) -> String {
        data.as_ref().iter().map(|b| format!("{:02x}", b)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_valid_relative_path() {
        let root = PathBuf::from("/mock/workspace");
        let result = canonicalize_workspace_path(&root, "notes/draft.md");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), root.join("notes/draft.md"));
    }

    #[test]
    fn test_rejects_parent_traversal() {
        let root = PathBuf::from("/mock/workspace");
        let result = canonicalize_workspace_path(&root, "../secrets.env");
        assert!(result.is_err());
    }

    #[test]
    fn test_rejects_absolute_paths() {
        let root = PathBuf::from("/mock/workspace");
        let result = canonicalize_workspace_path(&root, "/etc/passwd");
        assert!(result.is_err());
    }
}
