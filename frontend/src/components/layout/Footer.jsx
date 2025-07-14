import React from 'react';

const Footer = () => {
    // Removed marginTop for a cleaner layout
    return (
        <footer style={{ textAlign: 'center', padding: '20px', backgroundColor: '#ecf0f1' }}>
            <p>&copy; {new Date().getFullYear()} EduPro. All rights reserved.</p>
        </footer>
    );
};

export default Footer;