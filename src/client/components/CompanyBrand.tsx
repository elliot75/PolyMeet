import companyLogo from '../assets/uni-president-vietnam.png';

export function CompanyLogo() {
  return (
    <img
      className="company-logo"
      src={companyLogo}
      alt="UNI-PRESIDENT VIETNAM CO., LTD."
      width={142}
      height={142}
    />
  );
}

export function CompanyCopyright() {
  return (
    <footer className="company-copyright">
      <small lang="en">© 2026 UNI-PRESIDENT VIETNAM CO., LTD. All rights reserved.</small>
    </footer>
  );
}
