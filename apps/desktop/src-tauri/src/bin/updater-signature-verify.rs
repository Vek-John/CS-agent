use cs_agent_desktop_lib::updater::verify_updater_archive_signature;
use std::{fs, path::Path, process::ExitCode};

const ARGUMENT_ERROR: &str = "VERIFY_ARGUMENT_INVALID";
const SIGNATURE_FILE_ERROR: &str = "VERIFY_SIGNATURE_FILE_INVALID";

fn main() -> ExitCode {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.len() != 4 {
        println!("{ARGUMENT_ERROR}");
        return ExitCode::from(2);
    }
    let signature_path = Path::new(&arguments[3]);
    let signature_is_bounded = fs::metadata(signature_path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0 && metadata.len() <= 4096);
    if !signature_is_bounded {
        println!("{SIGNATURE_FILE_ERROR}");
        return ExitCode::from(2);
    }
    let Ok(signature) = fs::read_to_string(signature_path) else {
        println!("{SIGNATURE_FILE_ERROR}");
        return ExitCode::from(2);
    };
    match verify_updater_archive_signature(
        &arguments[1],
        Path::new(&arguments[2]),
        signature.trim(),
    ) {
        Ok(()) => {
            println!("PASS");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", error.code());
            ExitCode::from(2)
        }
    }
}
