document.addEventListener('DOMContentLoaded', async function () {
    // --- 1. Define Core Elements ---
    const lowStockCountElem = document.getElementById('low-stock-count');
    const expiringSoonCountElem = document.getElementById('expiring-soon-count');
    const categoryChartCanvas = document.getElementById('categoryChart');

    // Translated category names for the chart
    const categoryNames = {
        'PPE': 'PPE',
        'Diagnostics': 'Diagnostics',
        'Airway': 'Airway',
        'Circulation': 'Circulation',
        'Emergency_Medication': 'Emergency Medication',
        'Burns_Dressings': 'Burns/Dressings'
    };

    // --- 2. Fetch Dashboard Data from Server ---
    try {
        const response = await fetch('/api/dashboard-stats');
        if (!response.ok) {
            throw new Error(`Server responded with status: ${response.status}`);
        }
        const data = await response.json();

        // --- 3. Update Stat Cards ---
        if (lowStockCountElem) {
            lowStockCountElem.textContent = data.lowStockCount;
        }
        if (expiringSoonCountElem) {
            expiringSoonCountElem.textContent = data.expiringSoonCount;
        }

        // --- 4. Prepare Chart Data ---
        const labels = data.categoryCounts.map(item => categoryNames[item.category] || item.category);
        const counts = data.categoryCounts.map(item => item.count);
        
        // --- 5. Create the Chart ---
        if (categoryChartCanvas) {
            new Chart(categoryChartCanvas, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        label: '# of Items',
                        data: counts,
                        backgroundColor: [
                            'rgba(255, 99, 132, 0.7)',
                            'rgba(54, 162, 235, 0.7)',
                            'rgba(255, 206, 86, 0.7)',
                            'rgba(75, 192, 192, 0.7)',
                            'rgba(153, 102, 255, 0.7)',
                            'rgba(255, 159, 64, 0.7)'
                        ],
                        borderColor: [
                            'rgba(255, 99, 132, 1)',
                            'rgba(54, 162, 235, 1)',
                            'rgba(255, 206, 86, 1)',
                            'rgba(75, 192, 192, 1)',
                            'rgba(153, 102, 255, 1)',
                            'rgba(255, 159, 64, 1)'
                        ],
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'left', // More suitable for LTR
                        },
                        title: {
                            display: false
                        }
                    }
                }
            });
        }

    } catch (error) {
        console.error('Error loading dashboard data:', error);
    }
});

